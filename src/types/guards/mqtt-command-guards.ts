import type {
    MqttCoverCommand,
    MqttLightCommand,
    MqttScenarioCommand,
    MqttThermostatCommand,
} from '../mqtt.types';

export function isMqttLightCommand(cmd: unknown): cmd is MqttLightCommand {
    if (typeof cmd !== 'object' || cmd === null) {
        return false;
    }
    const obj = cmd as Record<string, unknown>;
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
    if (typeof cmd !== 'object' || cmd === null) {
        return false;
    }
    const obj = cmd as Record<string, unknown>;
    return (
        obj.position === undefined ||
        (typeof obj.position === 'number' &&
            Number.isFinite(obj.position) &&
            obj.position >= 0 &&
            obj.position <= 100)
    );
}

export function isMqttThermostatCommand(cmd: unknown): cmd is MqttThermostatCommand {
    if (typeof cmd !== 'object' || cmd === null) {
        return false;
    }
    const obj = cmd as Record<string, unknown>;
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
    if (typeof cmd !== 'object' || cmd === null) {
        return false;
    }
    const obj = cmd as Record<string, unknown>;
    return obj.active === undefined || typeof obj.active === 'boolean';
}
