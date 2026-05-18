import type { API, Logger } from 'homebridge';
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
import { PLUGIN_NAME } from '../settings';
import { PLUGIN_VERSION } from '../plugin-version';
import type { KseniaWebSocketClient } from '../websocket-client';

// Matter Thermostat systemMode values (Matter spec 1.3 §4.3.7.22)
const THERMOSTAT_MODE_OFF = 0;
const THERMOSTAT_MODE_AUTO = 1;
const THERMOSTAT_MODE_COOL = 3;
const THERMOSTAT_MODE_HEAT = 4;

// Matter Thermostat controlSequenceOfOperation: 4 = Heating And Cooling
const THERMOSTAT_CONTROL_SEQ_HEAT_COOL = 4;

function domainModeToMatter(mode: 'off' | 'heat' | 'cool' | 'auto'): number {
    switch (mode) {
        case 'heat': return THERMOSTAT_MODE_HEAT;
        case 'cool': return THERMOSTAT_MODE_COOL;
        case 'auto': return THERMOSTAT_MODE_AUTO;
        default: return THERMOSTAT_MODE_OFF;
    }
}

function matterModeToDomain(systemMode: number): 'off' | 'heat' | 'cool' | 'auto' {
    switch (systemMode) {
        case THERMOSTAT_MODE_HEAT: return 'heat';
        case THERMOSTAT_MODE_COOL: return 'cool';
        case THERMOSTAT_MODE_AUTO: return 'auto';
        default: return 'off';
    }
}

// Matter temperatures are in centidegrees (°C * 100)
function toCentidegrees(celsius: number): number {
    return Math.round(celsius * 100);
}

function clampCentidegrees(val: number): number {
    return Math.max(-27000, Math.min(10000, val));
}

interface MapperDeps {
    api: API;
    log: Logger;
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
    const { api, log, getWsClient } = deps;
    const isDimmable = device.status?.dimmable ?? false;
    const onOff = device.status?.on ?? false;
    const level = device.status?.brightness ?? (onOff ? 100 : 0);

    const clusters: MatterAccessory['clusters'] = isDimmable
        ? {
            onOff: { onOff },
            levelControl: { currentLevel: Math.round((level / 100) * 254), minLevel: 1, maxLevel: 254 },
        }
        : { onOff: { onOff } };

    const handlers: MatterAccessory['handlers'] = {
        onOff: {
            on: async () => {
                await getWsClient()?.switchLight(device.id, true);
            },
            off: async () => {
                await getWsClient()?.switchLight(device.id, false);
            },
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
    const { api, log, getWsClient } = deps;
    const pos = device.status?.position ?? 0;
    // Matter WindowCovering position is in percent * 100 (0–10000), and 0 = fully open, 10000 = fully closed
    // Lares4 position: 0 = closed, 100 = open — invert for Matter
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
                    // Matter 0=open 10000=closed → Lares4 0=closed 100=open
                    const targetPct = 100 - Math.round(args.liftPercent100thsValue / 100);
                    await getWsClient()?.moveCover(device.id, targetPct);
                },
            },
        },
    };
}

function mapThermostat(device: KseniaThermostat, deps: MapperDeps): MatterAccessory {
    const { api, log, getWsClient } = deps;
    const currentTemp = device.currentTemperature ?? 21;
    const targetTemp = device.targetTemperature ?? 21;

    return {
        ...baseFields(device),
        deviceType: api.matter!.deviceTypes.Thermostat,
        clusters: {
            thermostat: {
                localTemperature: clampCentidegrees(toCentidegrees(currentTemp)),
                occupiedHeatingSetpoint: toCentidegrees(targetTemp),
                occupiedCoolingSetpoint: toCentidegrees(targetTemp),
                systemMode: domainModeToMatter(device.mode),
                controlSequenceOfOperation: THERMOSTAT_CONTROL_SEQ_HEAT_COOL,
            },
        },
        handlers: {
            thermostat: {
                setpointRaiseLower: async (args: { mode: number; amount: number }) => {
                    const newTarget = targetTemp + args.amount / 10;
                    await getWsClient()?.setThermostatTemperature(device.id, newTarget);
                },
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
                        measuredValue: clampCentidegrees(toCentidegrees(val)),
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
        case 'motion':
            return {
                ...baseFields(device),
                deviceType: api.matter!.deviceTypes.MotionSensor,
                clusters: {
                    occupancySensing: {
                        occupancy: { occupied: val > 0 },
                    },
                },
            };
        case 'contact':
            return {
                ...baseFields(device),
                deviceType: api.matter!.deviceTypes.ContactSensor,
                clusters: {
                    booleanState: { stateValue: val === 0 }, // true = contact detected (closed)
                },
            };
        default:
            return undefined;
    }
}

function mapZone(device: KseniaZone, deps: MapperDeps): MatterAccessory {
    const { api } = deps;
    // Zone: open = intrusione rilevata (stateValue false = alarm)
    const contactClosed = !device.status.open;
    return {
        ...baseFields(device),
        deviceType: api.matter!.deviceTypes.ContactSensor,
        clusters: {
            booleanState: { stateValue: contactClosed },
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
                on: async () => {
                    await getWsClient()?.triggerScenario(device.id);
                },
                off: async () => {
                    // Scenarios are stateless triggers; no deactivation command
                },
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
                on: async () => {
                    await getWsClient()?.toggleGate(device.id);
                },
                off: async () => {
                    await getWsClient()?.toggleGate(device.id);
                },
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
            case 'light': return mapLight(device, deps);
            case 'cover': return mapCover(device, deps);
            case 'thermostat': return mapThermostat(device, deps);
            case 'sensor': return mapSensor(device, deps);
            case 'zone': return mapZone(device, deps);
            case 'scenario': return mapScenario(device, deps);
            case 'gate': return mapGate(device, deps);
            default: return undefined;
        }
    } catch (err) {
        deps.log.warn(`Matter mapper error for ${(device as KseniaDevice).name}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

export function matterSystemModeToDomain(systemMode: number): 'off' | 'heat' | 'cool' | 'auto' {
    return matterModeToDomain(systemMode);
}

export { toCentidegrees, clampCentidegrees };
