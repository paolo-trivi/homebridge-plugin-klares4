export interface MqttConfig {
    enabled: boolean;
    broker: string;
    port?: number;
    username?: string;
    password?: string;
    clientId?: string;
    topicPrefix?: string;
    qos?: 0 | 1 | 2;
    retain?: boolean;
    /** `false`: state only, the `.../set` command topics are not subscribed. Default `true`. */
    commands?: boolean;
}

export interface MqttLightCommand {
    on?: boolean;
    brightness?: number;
}

export interface MqttCoverCommand {
    position?: number;
}

export interface MqttThermostatCommand {
    targetTemperature?: number;
    mode?: 'off' | 'heat' | 'cool' | 'auto';
}

export interface MqttScenarioCommand {
    active?: boolean;
}

export type MqttDeviceCommand =
    | MqttLightCommand
    | MqttCoverCommand
    | MqttThermostatCommand
    | MqttScenarioCommand;

interface DeviceStatePayloadBase {
    id: string;
    name: string;
    type: string;
    timestamp: string;
}

export interface LightStatePayload extends DeviceStatePayloadBase {
    on: boolean;
    brightness: number;
    dimmable: boolean;
}

export interface CoverStatePayload extends DeviceStatePayloadBase {
    position: number;
    state: string;
}

export interface ThermostatStatePayload extends DeviceStatePayloadBase {
    currentTemperature: number;
    targetTemperature: number;
    mode: string;
    humidity?: number;
}

export interface SensorStatePayload extends DeviceStatePayloadBase {
    sensorType: string;
    value: number;
    unit: string;
}

export interface ZoneStatePayload extends DeviceStatePayloadBase {
    open: boolean;
    armed: boolean;
    fault: boolean;
    bypassed: boolean;
}

export interface ScenarioStatePayload extends DeviceStatePayloadBase {
    active: boolean;
}

export type DeviceStatePayload =
    | LightStatePayload
    | CoverStatePayload
    | ThermostatStatePayload
    | SensorStatePayload
    | ZoneStatePayload
    | ScenarioStatePayload;

/** Connection to the panel as last reported to the bridge; `unknown` until the first report. */
export type MqttPanelConnection = 'connected' | 'disconnected' | 'unknown';

/**
 * Retained payload of `<prefix>/status`. `offline` is also the broker-side
 * last will, so a crashed bridge or a lost network reads as `offline`.
 */
export type MqttStatusPayload =
    | { state: 'online'; panel: MqttPanelConnection; timestamp: string }
    | { state: 'offline' };
