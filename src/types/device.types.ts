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

/**
 * What the output does inside its thermostat program: it is the program's
 * `HEATING_OUT`, its `COOLING_OUT`, or both.
 */
export type ThermostatOutputRole = 'heating' | 'cooling' | 'heating-cooling';

export interface KseniaThermostat extends KseniaDeviceBase {
    type: 'thermostat';
    status: ThermostatStatus;
    currentTemperature: number;
    targetTemperature: number;
    mode: 'off' | 'heat' | 'cool' | 'auto';
    humidity?: number;
    /**
     * Role of this output, set from the program data (`PRG_THERMOSTATS` or the
     * `.ksa` cache, see `deriveThermostatOutputRole`). Absent when unknown.
     */
    outputRole?: ThermostatOutputRole;
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
    /** The panel's `PIN` flag for this scenario (`N`, `P`, `PR`), as listed; meaning not established. */
    pinFlag?: string;
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
