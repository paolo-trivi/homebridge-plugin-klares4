import type {
    MqttCoverCommand,
    MqttLightCommand,
    MqttScenarioCommand,
    MqttThermostatCommand,
} from '../mqtt.types';

/** The keys each command type acts on; a payload with none of them does nothing. */
export const MQTT_COMMAND_KEYS = {
    light: ['on', 'brightness'],
    cover: ['position'],
    thermostat: ['targetTemperature', 'mode'],
    scenario: ['active'],
} as const satisfies Record<string, readonly string[]>;

export type MqttCommandDeviceType = keyof typeof MQTT_COMMAND_KEYS;

function commandObject(cmd: unknown, type: MqttCommandDeviceType): Record<string, unknown> | null {
    if (typeof cmd !== 'object' || cmd === null || Array.isArray(cmd)) {
        return null;
    }
    const obj = cmd as Record<string, unknown>;
    return MQTT_COMMAND_KEYS[type].some((key) => obj[key] !== undefined) ? obj : null;
}

/** Keys of a command object that its type does not know (ignored by the bridge). */
export function unknownMqttCommandKeys(cmd: object, type: MqttCommandDeviceType): string[] {
    const known: readonly string[] = MQTT_COMMAND_KEYS[type];
    return Object.keys(cmd).filter((key) => !known.includes(key));
}

export function isMqttLightCommand(cmd: unknown): cmd is MqttLightCommand {
    const obj = commandObject(cmd, 'light');
    if (!obj) return false;
    return (
        (obj.on === undefined || typeof obj.on === 'boolean') &&
        (obj.brightness === undefined ||
            (typeof obj.brightness === 'number' &&
                Number.isFinite(obj.brightness) &&
                obj.brightness >= 0 &&
                obj.brightness <= 100))
    );
}

export function isMqttCoverCommand(cmd: unknown): cmd is MqttCoverCommand {
    const obj = commandObject(cmd, 'cover');
    if (!obj) return false;
    return (
        typeof obj.position === 'number' &&
        Number.isFinite(obj.position) &&
        obj.position >= 0 &&
        obj.position <= 100
    );
}

export function isMqttThermostatCommand(cmd: unknown): cmd is MqttThermostatCommand {
    const obj = commandObject(cmd, 'thermostat');
    if (!obj) return false;
    const validModes = ['off', 'heat', 'cool', 'auto'];
    return (
        (obj.targetTemperature === undefined ||
            (typeof obj.targetTemperature === 'number' &&
                Number.isFinite(obj.targetTemperature) &&
                obj.targetTemperature >= 5 &&
                obj.targetTemperature <= 40)) &&
        (obj.mode === undefined || (typeof obj.mode === 'string' && validModes.includes(obj.mode)))
    );
}

export function isMqttScenarioCommand(cmd: unknown): cmd is MqttScenarioCommand {
    const obj = commandObject(cmd, 'scenario');
    if (!obj) return false;
    return typeof obj.active === 'boolean';
}
