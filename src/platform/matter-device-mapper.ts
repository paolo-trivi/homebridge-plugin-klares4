import type { API } from 'homebridge';
import type { MatterAccessory } from 'homebridge';
import type {
    KseniaCover,
    KseniaDevice,
    KseniaGate,
    KseniaLight,
    KseniaScenario,
    KseniaSensor,
    KseniaThermostat,
    KseniaZone,
} from '../types';
import { PLUGIN_VERSION } from '../plugin-version';
import type { KseniaWebSocketClient } from '../websocket-client';
import {
    buildThermostatMatterState, toMatterTemperatureCelsius, clampMatterTemperature,
    TEMP_ABS_MIN_CENTI, TEMP_ABS_MAX_CENTI, thermostatSupportsCooling,
} from './matter-thermostat-mapper';
import { sanitizeMatterAccessoryName, MatterNameRegistry } from './matter-name-sanitizer';
import { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { buildThermostatHandlers } from './matter-thermostat-handlers';

const matterNameRegistry = new MatterNameRegistry();

/**
 * Drain the typed-suffix collision queue. When a high-priority device (cover,
 * light, thermostat, gate, scenario) displaces a previously-registered
 * sensor/zone that was sharing the same sanitised name, the displaced uuid is
 * queued here so the platform registry can refresh its matter metadata with
 * the new ' - Sens.' / ' - <Tipo>' suffix.
 */
export function consumePendingMatterRenames(): Map<string, string> {
    return matterNameRegistry.consumePendingRenames();
}

// Re-exports for legacy callers (registry pushStateUpdate, tests)
export { toMatterTemperatureCelsius as toCentidegrees };
export { buildThermostatMatterState };
export function clampCentidegrees(val: number): number {
    return clampMatterTemperature(val, TEMP_ABS_MIN_CENTI, TEMP_ABS_MAX_CENTI);
}

// Matter Thermostat systemMode values (Matter spec 1.3 §4.3.7.32): 0=Off, 1=Auto, 3=Cool, 4=Heat
export function domainModeToMatterMode(mode: 'off' | 'heat' | 'cool' | 'auto'): number {
    switch (mode) {
        case 'heat': return 4;
        case 'cool': return 3;
        case 'auto': return 1;
        default:     return 0;
    }
}

// Matter illuminance: measuredValue = 10000 * log10(lux) + 1  (Matter spec §2.2.5.1).
// Returns 0 for lux <= 0 (the spec uses 0 to mean "below the sensor's range").
export function luxToMatterIlluminance(lux: number): number {
    if (!Number.isFinite(lux) || lux <= 0) return 0;
    return Math.max(1, Math.min(65534, Math.round(10000 * Math.log10(lux) + 1)));
}

interface MapperDeps {
    api: API;
    log: import('homebridge').Logger;
    getWsClient: () => KseniaWebSocketClient | undefined;
    /** Auto-off delay (ms) for momentary OnOff devices (scenarios, gates). Default 500ms. */
    momentaryAutoOffMs?: number;
    /**
     * Plugin-level echo/idempotency tracker for Matter Thermostat attribute writes.
     * Required to break the self-sustaining matter.js handler-rewrite loop documented
     * in `matter-thermostat-echo-tracker.ts`. The mapper falls back to a no-op tracker
     * when omitted (kept for unit-test convenience).
     */
    thermostatEchoTracker?: MatterThermostatEchoTracker;
}

const DEFAULT_MOMENTARY_AUTO_OFF_MS = 500;

function scheduleMomentaryAutoOff(uuid: string, deps: MapperDeps): void {
    const delay = deps.momentaryAutoOffMs ?? DEFAULT_MOMENTARY_AUTO_OFF_MS;
    setTimeout(() => {
        deps.api.matter?.updateAccessoryState(uuid, 'onOff', { onOff: false })
            .catch((err: unknown) => {
                deps.log.debug(`[Matter] momentary auto-off failed for ${uuid}: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, delay);
}

function baseFields(
    device: KseniaDevice,
    log?: import('homebridge').Logger,
): Pick<MatterAccessory, 'UUID' | 'displayName' | 'serialNumber' | 'manufacturer' | 'model' | 'firmwareRevision' | 'context'> {
    const sanitized = matterNameRegistry.resolve(device.id, sanitizeMatterAccessoryName(device.name, device.id), device.type);
    if (log && sanitized !== device.name) log.debug(`[Matter] Accessory name sanitized: "${device.name}" -> "${sanitized}"`);
    return {
        UUID: device.id,
        displayName: sanitized,
        serialNumber: device.id,
        manufacturer: 'Ksenia',
        model: `Lares4 ${device.type}`,
        firmwareRevision: PLUGIN_VERSION,
        context: { device },
    };
}

function mapLight(device: KseniaLight, deps: MapperDeps): MatterAccessory {
    const { api, getWsClient } = deps;
    const isDimmable = device.status?.dimmable ?? false;
    const onOff = device.status?.on ?? false;
    const brightness = device.status?.brightness ?? (onOff ? 100 : 0);
    // Matter LevelControl: range 1–254. Level 0 is forbidden even when off — OnOff cluster owns on/off state.
    const currentLevel = Math.max(1, Math.round((brightness / 100) * 254));

    const clusters: MatterAccessory['clusters'] = isDimmable
        ? {
            onOff: { onOff },
            levelControl: { currentLevel, minLevel: 1, maxLevel: 254 },
        }
        : { onOff: { onOff } };

    const handlers: MatterAccessory['handlers'] = {
        onOff: {
            on: async () => { await getWsClient()?.switchLight(device.id, true); },
            off: async () => { await getWsClient()?.switchLight(device.id, false); },
        },
    };

    if (isDimmable) {
        handlers.levelControl = {
            moveToLevel: async (args: { level: number }) => {
                const pct = Math.round((args.level / 254) * 100);
                await getWsClient()?.dimLight(device.id, pct);
            },
            moveToLevelWithOnOff: async (args: { level: number }) => {
                const pct = Math.round((args.level / 254) * 100);
                await getWsClient()?.dimLight(device.id, pct);
            },
        };
    }

    return {
        ...baseFields(device, deps.log),
        deviceType: isDimmable
            ? api.matter!.deviceTypes.DimmableLight
            : api.matter!.deviceTypes.OnOffLight,
        clusters,
        handlers,
    };
}

function mapCover(device: KseniaCover, deps: MapperDeps): MatterAccessory {
    const { api, getWsClient } = deps;
    const pos = device.status?.position ?? 0;
    // Lares4: 0=closed, 100=open. Matter: 0=open (0%), 10000=closed (100%).
    const matterPos = Math.round((100 - pos) * 100);

    return {
        ...baseFields(device, deps.log),
        deviceType: api.matter!.deviceTypes.WindowCovering,
        clusters: {
            windowCovering: {
                currentPositionLiftPercent100ths: matterPos,
                targetPositionLiftPercent100ths: matterPos,
                configStatus: { liftPositionAware: true, operational: true },
            },
        },
        handlers: {
            windowCovering: {
                goToLiftPercentage: async (args: { liftPercent100thsValue: number }) => {
                    const targetPct = 100 - Math.round(args.liftPercent100thsValue / 100);
                    await getWsClient()?.moveCover(device.id, targetPct);
                },
            },
        },
    };
}

function mapThermostat(device: KseniaThermostat, deps: MapperDeps): MatterAccessory {
    const { api, log, getWsClient, thermostatEchoTracker } = deps;
    const { base, schemaInvariants } = buildThermostatMatterState(device);
    const supportsCooling = thermostatSupportsCooling(device);

    return {
        ...baseFields(device, log),
        deviceType: api.matter!.deviceTypes.Thermostat,
        clusters: {
            thermostat: { ...base, ...schemaInvariants } as Record<string, unknown>,
        },
        // The echo tracker is plugin-scoped (lives in MatterAccessoryRegistry). All
        // mapping calls for the same UUID — including re-mappings via
        // `refreshAccessoryMetadata` — share its state, which is what makes the
        // echo-suppression survive the multi-second WRITE_CFG round-trip.
        handlers: {
            thermostat: buildThermostatHandlers({ device, supportsCooling, log, getWsClient, tracker: thermostatEchoTracker }),
        },
    };
}

/**
 * Fallback mapping: register a thermostat as a Matter TemperatureSensor.
 * HAP continues to expose the full Thermostat — Matter loses write control but keeps read.
 */
export function mapThermostatAsTemperatureSensor(device: KseniaThermostat, deps: MapperDeps): MatterAccessory {
    const currentC = device.currentTemperature ?? 21;
    return {
        ...baseFields(device, deps.log),
        deviceType: deps.api.matter!.deviceTypes.TemperatureSensor,
        clusters: { temperatureMeasurement: { measuredValue: clampCentidegrees(toMatterTemperatureCelsius(currentC)) } },
    };
}

function mapSensor(device: KseniaSensor, deps: MapperDeps): MatterAccessory | undefined {
    const { api } = deps;
    const bf = baseFields(device, deps.log);
    const val = device.status.value;
    switch (device.status.sensorType) {
        case 'temperature': return { ...bf, deviceType: api.matter!.deviceTypes.TemperatureSensor, clusters: { temperatureMeasurement: { measuredValue: clampCentidegrees(toMatterTemperatureCelsius(val)) } } };
        case 'humidity':    return { ...bf, deviceType: api.matter!.deviceTypes.HumiditySensor,    clusters: { relativeHumidityMeasurement: { measuredValue: Math.round(Math.max(0, Math.min(100, val)) * 100) } } };
        case 'light':       return { ...bf, deviceType: api.matter!.deviceTypes.LightSensor,       clusters: { illuminanceMeasurement: { measuredValue: luxToMatterIlluminance(val) } } };
        case 'motion':      return { ...bf, deviceType: api.matter!.deviceTypes.MotionSensor,      clusters: { occupancySensing: { occupancy: { occupied: val > 0 } } } };
        case 'contact':     return { ...bf, deviceType: api.matter!.deviceTypes.ContactSensor,     clusters: { booleanState: { stateValue: val === 0 } } };
        default:            return undefined;
    }
}

function mapZone(device: KseniaZone, deps: MapperDeps): MatterAccessory {
    return { ...baseFields(device, deps.log), deviceType: deps.api.matter!.deviceTypes.ContactSensor, clusters: { booleanState: { stateValue: !device.status.open } } };
}

function mapMomentarySwitch(device: KseniaDevice, trigger: () => Promise<void>, deps: MapperDeps): MatterAccessory {
    // OnOffOutlet (= Matter OnOffPlugInUnit, 0x010A) instead of OnOffSwitch (0x0103).
    // OnOffSwitch is a Matter *client* device (a wall switch sending commands via binding) —
    // Alexa follows the spec and refuses to import it as a controllable accessory, leaving
    // scenarios invisible. OnOffOutlet is a controllable server device that every ecosystem
    // (Apple Home, Alexa, Google) exposes as a tappable plug.
    return {
        ...baseFields(device, deps.log),
        deviceType: deps.api.matter!.deviceTypes.OnOffOutlet,
        clusters: { onOff: { onOff: false } },
        handlers: { onOff: {
            on: async () => { await trigger(); scheduleMomentaryAutoOff(device.id, deps); },
            off: async () => { /* momentary trigger — no-op */ },
        } },
    };
}

function mapScenario(device: KseniaScenario, deps: MapperDeps): MatterAccessory {
    return mapMomentarySwitch(device, async () => { await deps.getWsClient()?.triggerScenario(device.id); }, deps);
}

function mapGate(device: KseniaGate, deps: MapperDeps): MatterAccessory {
    return mapMomentarySwitch(device, async () => { await deps.getWsClient()?.toggleGate(device.id); }, deps);
}

export function deviceToMatterAccessory(device: KseniaDevice, deps: MapperDeps): MatterAccessory | undefined {
    if (!deps.api.matter) {
        return undefined;
    }
    try {
        switch (device.type) {
            case 'light':      return mapLight(device, deps);
            case 'cover':      return mapCover(device, deps);
            case 'thermostat': return mapThermostat(device, deps);
            case 'sensor':     return mapSensor(device, deps);
            case 'zone':       return mapZone(device, deps);
            case 'scenario':   return mapScenario(device, deps);
            case 'gate':       return mapGate(device, deps);
            default:           return undefined;
        }
    } catch (err) {
        deps.log.warn(`[Matter] Mapper error for ${(device as KseniaDevice).name}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}
