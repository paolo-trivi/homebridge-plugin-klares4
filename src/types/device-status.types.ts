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
