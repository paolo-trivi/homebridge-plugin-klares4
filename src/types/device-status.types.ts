export interface LightStatus {
    on: boolean;
    brightness?: number;
    dimmable: boolean;
}

export interface CoverStatus {
    position: number;
    targetPosition?: number;
    state: 'stopped' | 'opening' | 'closing';
}

/**
 * What the output does inside its thermostat program: it is the program's
 * `HEATING_OUT`, its `COOLING_OUT`, or both.
 */
export type ThermostatOutputRole = 'heating' | 'cooling' | 'heating-cooling';

export interface ThermostatStatus {
    currentTemperature: number;
    targetTemperature: number;
    mode: 'off' | 'heat' | 'cool' | 'auto';
    humidity?: number;
    hvacOutputActive?: boolean;
    /** Active season of the thermostat program (`ACT_SEA`), when the panel reported it. */
    season?: 'WIN' | 'SUM';
    /** Role of this output in its thermostat program (`HEATING_OUT` / `COOLING_OUT`), when known. */
    outputRole?: ThermostatOutputRole;
}

export interface SensorStatus {
    sensorType: 'temperature' | 'humidity' | 'light' | 'motion' | 'contact';
    value: number;
    unit?: string;
}

export interface ZoneStatus {
    armed: boolean;
    bypassed: boolean;
    fault: boolean;
    open: boolean;
}

export interface ScenarioStatus {
    active: boolean;
}

export interface GateStatus {
    on: boolean;
}
