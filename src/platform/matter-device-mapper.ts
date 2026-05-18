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
import { buildThermostatMatterState, toMatterTemperatureCelsius, clampMatterTemperature, TEMP_ABS_MIN_CENTI, TEMP_ABS_MAX_CENTI } from './matter-thermostat-mapper';

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
}

function baseFields(device: KseniaDevice): Pick<MatterAccessory, 'UUID' | 'displayName' | 'serialNumber' | 'manufacturer' | 'model' | 'firmwareRevision' | 'context'> {
    return {
        UUID: device.id,
        displayName: device.name,
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
        ...baseFields(device),
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
        ...baseFields(device),
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
    const { api, getWsClient } = deps;
    const { base, schemaInvariants } = buildThermostatMatterState(device);

    return {
        ...baseFields(device),
        deviceType: api.matter!.deviceTypes.Thermostat,
        clusters: {
            thermostat: { ...base, ...schemaInvariants } as Record<string, unknown>,
        },
        handlers: {
            thermostat: {
                setpointRaiseLower: async (args: { mode: number; amount: number }) => {
                    const delta = args.amount / 10;
                    const newTarget = (device.targetTemperature ?? 21) + delta;
                    await getWsClient()?.setThermostatTemperature(device.id, newTarget);
                },
            },
        },
    };
}

/**
 * Fallback mapping: register a thermostat as a Matter TemperatureSensor.
 * Used only when the regular Thermostat registration fails upstream (matter.js bug).
 * HAP continues to expose the full Thermostat — Matter loses write control but keeps read.
 */
export function mapThermostatAsTemperatureSensor(device: KseniaThermostat, deps: MapperDeps): MatterAccessory {
    const { api } = deps;
    const currentC = device.currentTemperature ?? 21;
    return {
        ...baseFields(device),
        deviceType: api.matter!.deviceTypes.TemperatureSensor,
        clusters: {
            temperatureMeasurement: {
                measuredValue: clampCentidegrees(toMatterTemperatureCelsius(currentC)),
            },
        },
    };
}

function mapSensor(device: KseniaSensor, deps: MapperDeps): MatterAccessory | undefined {
    const { api } = deps;
    const val = device.status.value;

    switch (device.status.sensorType) {
        case 'temperature':
            return {
                ...baseFields(device),
                deviceType: api.matter!.deviceTypes.TemperatureSensor,
                clusters: {
                    temperatureMeasurement: {
                        measuredValue: clampCentidegrees(toMatterTemperatureCelsius(val)),
                    },
                },
            };
        case 'humidity':
            return {
                ...baseFields(device),
                deviceType: api.matter!.deviceTypes.HumiditySensor,
                clusters: {
                    relativeHumidityMeasurement: {
                        measuredValue: Math.round(Math.max(0, Math.min(100, val)) * 100),
                    },
                },
            };
        case 'light':
            return {
                ...baseFields(device),
                deviceType: api.matter!.deviceTypes.LightSensor,
                clusters: {
                    illuminanceMeasurement: { measuredValue: luxToMatterIlluminance(val) },
                },
            };
        case 'motion':
            return {
                ...baseFields(device),
                deviceType: api.matter!.deviceTypes.MotionSensor,
                clusters: {
                    occupancySensing: { occupancy: { occupied: val > 0 } },
                },
            };
        case 'contact':
            return {
                ...baseFields(device),
                deviceType: api.matter!.deviceTypes.ContactSensor,
                clusters: {
                    booleanState: { stateValue: val === 0 },
                },
            };
        default:
            return undefined;
    }
}

function mapZone(device: KseniaZone, deps: MapperDeps): MatterAccessory {
    const { api } = deps;
    return {
        ...baseFields(device),
        deviceType: api.matter!.deviceTypes.ContactSensor,
        clusters: {
            booleanState: { stateValue: !device.status.open },
        },
    };
}

function mapScenario(device: KseniaScenario, deps: MapperDeps): MatterAccessory {
    const { api, getWsClient } = deps;
    return {
        ...baseFields(device),
        deviceType: api.matter!.deviceTypes.OnOffSwitch,
        clusters: {
            onOff: { onOff: device.status.active },
        },
        handlers: {
            onOff: {
                on: async () => { await getWsClient()?.triggerScenario(device.id); },
                off: async () => { /* stateless trigger */ },
            },
        },
    };
}

function mapGate(device: KseniaGate, deps: MapperDeps): MatterAccessory {
    const { api, getWsClient } = deps;
    return {
        ...baseFields(device),
        deviceType: api.matter!.deviceTypes.OnOffOutlet,
        clusters: {
            onOff: { onOff: device.status.on },
        },
        handlers: {
            onOff: {
                on: async () => { await getWsClient()?.toggleGate(device.id); },
                off: async () => { await getWsClient()?.toggleGate(device.id); },
            },
        },
    };
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
