import type {
    CoverStatus,
    GateStatus,
    LightStatus,
    ScenarioStatus,
    SensorStatus,
    ThermostatStatus,
    ZoneStatus,
} from './device-status.types';

interface KseniaDeviceBase {
    id: string;
    name: string;
    description: string;
}

export interface KseniaLight extends KseniaDeviceBase {
    type: 'light';
    status: LightStatus;
}

export interface KseniaCover extends KseniaDeviceBase {
    type: 'cover';
    status: CoverStatus;
}

export interface KseniaThermostat extends KseniaDeviceBase {
    type: 'thermostat';
    status: ThermostatStatus;
    currentTemperature: number;
    targetTemperature: number;
    mode: 'off' | 'heat' | 'cool' | 'auto';
    humidity?: number;
}

export interface KseniaSensor extends KseniaDeviceBase {
    type: 'sensor';
    status: SensorStatus;
}

export interface KseniaZone extends KseniaDeviceBase {
    type: 'zone';
    status: ZoneStatus;
}

export interface KseniaScenario extends KseniaDeviceBase {
    type: 'scenario';
    status: ScenarioStatus;
}

export interface KseniaGate extends KseniaDeviceBase {
    type: 'gate';
    status: GateStatus;
}

export type KseniaDevice =
    | KseniaLight
    | KseniaCover
    | KseniaThermostat
    | KseniaSensor
    | KseniaZone
    | KseniaScenario
    | KseniaGate;
