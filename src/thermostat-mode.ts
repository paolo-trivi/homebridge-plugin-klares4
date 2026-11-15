export type ThermostatMode = 'off' | 'heat' | 'cool' | 'auto';

/**
 * A Ksenia mode string as a domain mode, or `undefined` for a value the plugin
 * does not know: an unknown state must not be shown as "off".
 */
export function parseKseniaMode(mode: unknown): ThermostatMode | undefined {
    if (typeof mode !== 'string') return undefined;
    switch (mode.trim().toLowerCase()) {
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
            return 'off';
        default:
            return undefined;
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

/**
 * HomeKit CurrentHeatingCoolingState (0 idle, 1 heating, 2 cooling). The
 * panel's output state decides when known; heat or cool comes from the mode
 * and, in AUTO, from the season (`WIN` heats, `SUM` cools). Without the output
 * state the room and target temperatures stand in, in the season's direction.
 */
export function deriveHomeKitCurrentState(
    mode: ThermostatMode,
    currentTemperature: number,
    targetTemperature: number,
    outputActive?: boolean,
    season?: 'WIN' | 'SUM',
): 0 | 1 | 2 {
    if (mode === 'off' || outputActive === false) {
        return 0;
    }
    const direction = mode === 'heat' ? 1 : mode === 'cool' ? 2 : seasonDirection(season);
    if (outputActive === true && direction !== undefined) {
        return direction;
    }
    if (direction === 1) return currentTemperature < targetTemperature ? 1 : 0;
    if (direction === 2) return currentTemperature > targetTemperature ? 2 : 0;
    if (currentTemperature < targetTemperature) return 1;
    if (currentTemperature > targetTemperature) return 2;

    return 0;
}

function seasonDirection(season: 'WIN' | 'SUM' | undefined): 1 | 2 | undefined {
    if (season === 'WIN') return 1;
    if (season === 'SUM') return 2;
    return undefined;
}
