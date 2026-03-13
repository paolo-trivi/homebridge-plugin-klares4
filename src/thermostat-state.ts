import type { KseniaThermostat, ThermostatStatus } from './types';
import type { ThermostatMode } from './thermostat-mode';

export function createDefaultThermostatStatus(): ThermostatStatus {
    return {
        currentTemperature: 20,
        targetTemperature: 21,
        mode: 'off',
    };
}

export function createDefaultThermostatState(): Pick<
    KseniaThermostat,
    'status' | 'currentTemperature' | 'targetTemperature' | 'mode'
> {
    const status = createDefaultThermostatStatus();
    return {
        status,
        currentTemperature: status.currentTemperature,
        targetTemperature: status.targetTemperature,
        mode: status.mode,
    };
}

export function syncThermostatTopLevelFromStatus(device: KseniaThermostat): void {
    device.currentTemperature = device.status.currentTemperature;
    device.targetTemperature = device.status.targetTemperature;
    device.mode = device.status.mode;
    if (device.status.humidity !== undefined) {
        device.humidity = device.status.humidity;
    }
}

export function updateThermostatStatus(
    device: KseniaThermostat,
    partial: Partial<{
        currentTemperature: number;
        targetTemperature: number;
        mode: ThermostatMode;
        humidity: number | undefined;
        hvacOutputActive: boolean;
    }>,
): boolean {
    let changed = false;

    if (
        partial.currentTemperature !== undefined &&
        partial.currentTemperature !== device.status.currentTemperature
    ) {
        device.status.currentTemperature = partial.currentTemperature;
        changed = true;
    }

    if (
        partial.targetTemperature !== undefined &&
        partial.targetTemperature !== device.status.targetTemperature
    ) {
        device.status.targetTemperature = partial.targetTemperature;
        changed = true;
    }

    if (partial.mode !== undefined && partial.mode !== device.status.mode) {
        device.status.mode = partial.mode;
        changed = true;
    }

    if (partial.humidity !== undefined && partial.humidity !== device.status.humidity) {
        device.status.humidity = partial.humidity;
        changed = true;
    }

    if (
        partial.hvacOutputActive !== undefined &&
        partial.hvacOutputActive !== device.status.hvacOutputActive
    ) {
        device.status.hvacOutputActive = partial.hvacOutputActive;
        changed = true;
    }

    if (changed) {
        syncThermostatTopLevelFromStatus(device);
    }

    return changed;
}
