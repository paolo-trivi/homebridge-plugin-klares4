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
import { contextWithObservation, hasObservedState } from '../device-observation';
import type { KseniaWebSocketClient } from '../websocket-client';
import { buildThermostatMatterState, toMatterTemperatureCelsius, thermostatSupportsCooling } from './matter-thermostat-mapper';
import { sanitizeMatterAccessoryName, MatterNameRegistry } from './matter-name-sanitizer';
import { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { buildThermostatHandlers } from './matter-thermostat-handlers';
import { buildCoverHandlers, buildLightHandlers, buildMomentaryHandlers, requireWsClient } from './matter-command-handlers';
import {
    coverLift, finiteNumber, humidityMeasuredValue, MAX_LEVEL, MIN_LEVEL, illuminanceMeasuredValue, levelFromBrightness, temperatureMeasuredValue,
} from './matter-value-guards';

const matterNameRegistry = new MatterNameRegistry();

/**
 * Drain the typed-suffix collision queue of the module-level fallback
 * registry. Legacy escape hatch: since 2.1.4-rc.6 the authoritative naming
 * source is the batch name-map (`MatterNameService`, injected via
 * `MapperDeps.resolveDisplayName`), and `MatterAccessoryRegistry` refreshes
 * renamed accessories from the finalize diff instead of this queue.
 */
export function consumePendingMatterRenames(): Map<string, string> {
    return matterNameRegistry.consumePendingRenames();
}

// Re-exports for legacy callers (registry pushStateUpdate, tests)
export { toMatterTemperatureCelsius as toCentidegrees };
export { buildThermostatMatterState };
export { clampCentidegrees, luxToMatterIlluminance } from './matter-value-guards';

// Matter Thermostat systemMode values (Matter spec 1.3 §4.3.7.32): 0=Off, 1=Auto, 3=Cool, 4=Heat
export function domainModeToMatterMode(mode: 'off' | 'heat' | 'cool' | 'auto'): number {
    switch (mode) {
        case 'heat': return 4;
        case 'cool': return 3;
        case 'auto': return 1;
        default:     return 0;
    }
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
    /**
     * Authoritative displayName resolver (the batch name-map owned by
     * `MatterNameService`). When omitted (unit tests, legacy callers) the
     * mapper falls back to the module-level incremental registry.
     */
    resolveDisplayName?: (device: KseniaDevice) => string;
    /**
     * Latest known snapshot for a device ID. Homebridge registers handlers once
     * per endpoint, so they outlive the device captured at mapping time.
     */
    getLatestDevice?: (id: string) => KseniaDevice | undefined;
    /** Re-publish the known state of a device after a command the panel refused. */
    republishState?: (id: string) => void;
}

function latestSnapshot<T extends KseniaDevice>(device: T, deps: MapperDeps): T {
    const latest = deps.getLatestDevice?.(device.id);
    return latest?.type === device.type ? latest as T : device;
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
    deps: MapperDeps,
): Pick<MatterAccessory, 'UUID' | 'displayName' | 'serialNumber' | 'manufacturer' | 'model' | 'firmwareRevision' | 'context'> {
    const sanitized = deps.resolveDisplayName
        ? deps.resolveDisplayName(device)
        : matterNameRegistry.resolve(device.id, sanitizeMatterAccessoryName(device.name, device.id), device.type);
    if (sanitized !== device.name) deps.log.debug(`[Matter] Accessory name sanitized: "${device.name}" -> "${sanitized}"`);
    return {
        UUID: device.id,
        displayName: sanitized,
        serialNumber: device.id,
        manufacturer: 'Ksenia',
        model: `Lares4 ${device.type}`,
        firmwareRevision: PLUGIN_VERSION,
        context: contextWithObservation(device),
    };
}

/**
 * Identity/metadata comparison used to decide whether a re-mapped accessory
 * warrants a metadata refresh (and the `metadataChanged` cycle stat).
 */
export function hasAccessoryMetadataChanged(previous: MatterAccessory, next: MatterAccessory): boolean {
    return previous.displayName !== next.displayName
        || previous.manufacturer !== next.manufacturer
        || previous.model !== next.model
        || previous.serialNumber !== next.serialNumber
        || previous.firmwareRevision !== next.firmwareRevision;
}

function mapLight(device: KseniaLight, deps: MapperDeps): MatterAccessory {
    const { api, getWsClient, log } = deps;
    const isDimmable = device.status?.dimmable === true;
    const onOff = device.status?.on === true;
    // LevelControl range 1–254: level 0 is forbidden even when off, OnOff owns the on/off state.
    const currentLevel = levelFromBrightness(device.status?.brightness) ?? (onOff ? MAX_LEVEL : MIN_LEVEL);

    const clusters: MatterAccessory['clusters'] = isDimmable
        ? {
            onOff: { onOff },
            levelControl: { currentLevel, minLevel: 1, maxLevel: 254 },
        }
        : { onOff: { onOff } };

    const handlers = buildLightHandlers(device, isDimmable, {
        api, getWsClient, log, latest: () => latestSnapshot(device, deps),
    });

    return {
        ...baseFields(device, deps),
        deviceType: isDimmable
            ? api.matter!.deviceTypes.DimmableLight
            : api.matter!.deviceTypes.OnOffLight,
        clusters,
        handlers,
    };
}

/**
 * Lares4: 0=closed, 100=open. Matter: 0=open (0%), 10000=closed (100%).
 * Kept for callers of the 2.2 API; `null` stands for an unknown position.
 */
export function coverLiftPercent100ths(status: Partial<KseniaCover['status']> | undefined): {
    currentPositionLiftPercent100ths: number | null;
    targetPositionLiftPercent100ths: number | null;
} {
    const { current, target } = coverLift(status);
    return { currentPositionLiftPercent100ths: current ?? null, targetPositionLiftPercent100ths: target ?? null };
}

function mapCover(device: KseniaCover, deps: MapperDeps): MatterAccessory {
    const { api, getWsClient, log } = deps;

    return {
        ...baseFields(device, deps),
        deviceType: api.matter!.deviceTypes.WindowCovering,
        clusters: {
            windowCovering: {
                ...coverLiftPercent100ths(device.status),
                configStatus: { liftPositionAware: true, operational: true },
            },
        },
        handlers: buildCoverHandlers(device, { api, getWsClient, log, latest: () => latestSnapshot(device, deps) }),
    };
}

function mapThermostat(device: KseniaThermostat, deps: MapperDeps): MatterAccessory {
    const { api, log, getWsClient, thermostatEchoTracker } = deps;
    const { base, schemaInvariants } = buildThermostatMatterState(device);
    const supportsCooling = thermostatSupportsCooling(device);

    return {
        ...baseFields(device, deps),
        deviceType: api.matter!.deviceTypes.Thermostat,
        clusters: {
            thermostat: { ...base, ...schemaInvariants } as Record<string, unknown>,
        },
        // The echo tracker is plugin-scoped (lives in MatterAccessoryRegistry). All
        // mapping calls for the same UUID — including re-mappings via
        // `refreshAccessoryMetadata` — share its state, which is what makes the
        // echo-suppression survive the multi-second WRITE_CFG round-trip.
        handlers: {
            thermostat: buildThermostatHandlers({
                device, supportsCooling, log, getWsClient, tracker: thermostatEchoTracker,
                getDevice: () => latestSnapshot(device, deps),
                republish: () => deps.republishState?.(device.id),
            }),
        },
    };
}

/**
 * Fallback mapping: register a thermostat as a Matter TemperatureSensor.
 * HAP continues to expose the full Thermostat — Matter loses write control but keeps read.
 */
export function mapThermostatAsTemperatureSensor(device: KseniaThermostat, deps: MapperDeps): MatterAccessory {
    return {
        ...baseFields(device, deps),
        deviceType: deps.api.matter!.deviceTypes.TemperatureSensor,
        clusters: { temperatureMeasurement: { measuredValue: measured(device, temperatureMeasuredValue(device.currentTemperature)) } },
    };
}

/**
 * MeasuredValue is nullable ("unknown") in all three measurement clusters. A
 * discovery placeholder (0 °C, 0 lux) with no cached state behind it, or a
 * value that is not a finite number, must not become the endpoint's first
 * reading; the first real value fills it in.
 */
function measured(device: KseniaDevice, value: number | undefined): number | null {
    return hasObservedState(device) && value !== undefined ? value : null;
}

function mapSensor(device: KseniaSensor, deps: MapperDeps): MatterAccessory | undefined {
    const { api } = deps;
    const bf = baseFields(device, deps);
    const val = device.status.value;
    switch (device.status.sensorType) {
        case 'temperature': return { ...bf, deviceType: api.matter!.deviceTypes.TemperatureSensor, clusters: { temperatureMeasurement: { measuredValue: measured(device, temperatureMeasuredValue(val)) } } };
        case 'humidity':    return { ...bf, deviceType: api.matter!.deviceTypes.HumiditySensor,    clusters: { relativeHumidityMeasurement: { measuredValue: measured(device, humidityMeasuredValue(val)) } } };
        case 'light':       return { ...bf, deviceType: api.matter!.deviceTypes.LightSensor,       clusters: { illuminanceMeasurement: { measuredValue: measured(device, illuminanceMeasuredValue(val)) } } };
        case 'motion':      return { ...bf, deviceType: api.matter!.deviceTypes.MotionSensor,      clusters: { occupancySensing: { occupancy: { occupied: (finiteNumber(val) ?? 0) > 0 } } } };
        case 'contact':     return { ...bf, deviceType: api.matter!.deviceTypes.ContactSensor,     clusters: { booleanState: { stateValue: val === 0 } } };
        default:            return undefined;
    }
}

function mapZone(device: KseniaZone, deps: MapperDeps): MatterAccessory {
    return { ...baseFields(device, deps), deviceType: deps.api.matter!.deviceTypes.ContactSensor, clusters: { booleanState: { stateValue: !device.status.open } } };
}

function mapMomentarySwitch(device: KseniaDevice, trigger: () => Promise<void>, deps: MapperDeps): MatterAccessory {
    // OnOffOutlet (= Matter OnOffPlugInUnit, 0x010A) instead of OnOffSwitch (0x0103).
    // OnOffSwitch is a Matter *client* device (a wall switch sending commands via binding) —
    // Alexa follows the spec and refuses to import it as a controllable accessory, leaving
    // scenarios invisible. OnOffOutlet is a controllable server device that every ecosystem
    // (Apple Home, Alexa, Google) exposes as a tappable plug.
    return {
        ...baseFields(device, deps),
        deviceType: deps.api.matter!.deviceTypes.OnOffOutlet,
        clusters: { onOff: { onOff: false } },
        handlers: buildMomentaryHandlers(async () => { await trigger(); scheduleMomentaryAutoOff(device.id, deps); }),
    };
}

function mapScenario(device: KseniaScenario, deps: MapperDeps): MatterAccessory {
    return mapMomentarySwitch(device, async () => { await requireWsClient(deps.api, deps.getWsClient).triggerScenario(device.id); }, deps);
}

function mapGate(device: KseniaGate, deps: MapperDeps): MatterAccessory {
    return mapMomentarySwitch(device, async () => { await requireWsClient(deps.api, deps.getWsClient).toggleGate(device.id); }, deps);
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
