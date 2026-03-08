export type ThermostatMode = 'off' | 'heat' | 'cool' | 'auto';

export function kseniaModeToDomain(mode: string | undefined): ThermostatMode {
    switch (mode?.toLowerCase()) {
        case '1':
        case 'heat':
        case 'heating':
        case 'riscaldamento':
            return 'heat';
        case '2':
        case 'cool':
        case 'cooling':
        case 'raffreddamento':
            return 'cool';
        case '3':
        case 'auto':
        case 'automatic':
        case 'automatico':
            return 'auto';
        case '0':
        case 'off':
        case 'spento':
        default:
            return 'off';
    }
}

export function domainModeToKsenia(mode: ThermostatMode): '0' | '1' | '2' | '3' {
    switch (mode) {
        case 'heat':
            return '1';
        case 'cool':
            return '2';
        case 'auto':
            return '3';
        default:
            return '0';
    }
}

export function domainModeToHomeKitTarget(mode: ThermostatMode): 0 | 1 | 2 | 3 {
    switch (mode) {
        case 'heat':
            return 1;
        case 'cool':
            return 2;
        case 'auto':
            return 3;
        default:
            return 0;
    }
}

export function homeKitTargetToDomainMode(value: number): ThermostatMode {
    switch (value) {
        case 1:
            return 'heat';
        case 2:
            return 'cool';
        case 3:
            return 'auto';
        default:
            return 'off';
    }
}

export function deriveHomeKitCurrentState(
    mode: ThermostatMode,
    currentTemperature: number,
    targetTemperature: number,
): 0 | 1 | 2 {
    if (mode === 'off') {
        return 0;
    }

    if (mode === 'heat') return currentTemperature < targetTemperature ? 1 : 0;
    if (mode === 'cool') return currentTemperature > targetTemperature ? 2 : 0;
    if (currentTemperature < targetTemperature) return 1;
    if (currentTemperature > targetTemperature) return 2;

    return 0;
}
