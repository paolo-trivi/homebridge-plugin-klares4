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

export interface ThermostatStatus {
    currentTemperature: number;
    targetTemperature: number;
    mode: 'off' | 'heat' | 'cool' | 'auto';
    humidity?: number;
    hvacOutputActive?: boolean;
    /** Active season: realtime `ACT_SEA`, else the cfg read from the panel. */
    season?: 'WIN' | 'SUM';
    /** Role of this output in its PRG_THERMOSTATS program (`HEATING_OUT` / `COOLING_OUT`), when known. */
    outputRole?: 'heating' | 'cooling';
    /** When the panel last reported this thermostat in realtime (STATUS_TEMPERATURES), epoch ms. */
    observedAt?: number;
    /**
     * What the panel last acknowledged (WRITE_CFG_RES OK) for this thermostat's
     * cfg, epoch ms. Newer than `observedAt`: the realtime has not caught up yet.
     */
    acknowledged?: {
        mode?: 'off' | 'heat' | 'cool' | 'auto';
        targetTemperature?: number;
        at: number;
    };
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
