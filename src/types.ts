/**
 * Type definitions for homebridge-plugin-klares4
 * Strict TypeScript compliant - no 'any' types
 */

// ============================================================================
// Device Status Interfaces
// ============================================================================

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

// ============================================================================
// Device Interfaces (Discriminated Union)
// ============================================================================

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

/**
 * Discriminated union of all device types
 */
export type KseniaDevice =
    | KseniaLight
    | KseniaCover
    | KseniaThermostat
    | KseniaSensor
    | KseniaZone
    | KseniaScenario
    | KseniaGate;

// ============================================================================
// WebSocket Message Interfaces
// ============================================================================

export interface KseniaMessagePayload {
    PIN?: string;
    ID_LOGIN?: string;
    RESULT?: string;
    RESULT_DETAIL?: string;
    ZONES?: KseniaZoneData[];
    OUTPUTS?: KseniaOutputData[];
    SCENARIOS?: KseniaScenarioData[];
    BUS_HAS?: KseniaBusHaData[];
    STATUS_OUTPUTS?: KseniaOutputStatusRaw[];
    STATUS_BUS_HA_SENSORS?: KseniaSensorStatusRaw[];
    STATUS_ZONES?: KseniaZoneStatusRaw[];
    STATUS_SYSTEM?: KseniaSystemStatus;
    ID_ITEMS_RANGE?: string[];
    TYPES?: string[];
    OUTPUT?: KseniaOutputCommand;
    [key: string]: unknown;
}

export interface KseniaMessage {
    SENDER: string;
    RECEIVER: string;
    CMD: string;
    ID: string;
    PAYLOAD_TYPE: string;
    PAYLOAD: KseniaMessagePayload;
    TIMESTAMP: string;
    CRC_16: string;
}

export interface KseniaWebSocketOptions {
    debug?: boolean;
    logLevel?: number;
    reconnectInterval?: number;
    heartbeatInterval?: number;
}

// ============================================================================
// Raw API Response Interfaces
// ============================================================================

export interface KseniaOutputData {
    ID: string;
    DES: string;
    TYPE: string;
    STATUS: string;
    POS?: string;
    ENABLED: string;
    CAT?: string;
    MOD?: string; // Modalità: M=Monostabile, B=Bistabile, BDP=Biposizionale, etc.
}

export interface KseniaZoneData {
    ID: string;
    DES: string;
    TYPE: string;
    STATUS: string;
    ENABLED: string;
}

export interface KseniaSensorData {
    ID: string;
    DES: string;
    TYPE: string;
    VALUE: string;
    UNIT?: string;
    ENABLED: string;
}

export interface KseniaScenarioData {
    ID: string;
    DES: string;
    CAT?: string;
    ENABLED?: string;
}

export interface KseniaBusHaData {
    ID: string;
    DES: string;
    TYPE?: string;
    ENABLED?: string;
}

export interface KseniaOutputStatusRaw {
    ID: string;
    STA: string;
    POS?: string;
    TPOS?: string;
    TEMP_CURRENT?: string;
    TEMP_TARGET?: string;
    MODE?: string;
}

export interface KseniaSensorStatusRaw {
    ID: string;
    DOMUS?: {
        TEM?: string;
        HUM?: string;
        LHT?: string;
    };
}

export interface KseniaZoneStatusRaw {
    ID: string;
    STA: string;
    BYP?: string;
    A?: string;
    FM?: string;
}

export interface KseniaSystemStatus {
    ID?: string;
    TEMP?: {
        IN?: string;
        OUT?: string;
    };
    [key: string]: unknown;
}

export interface KseniaOutputCommand {
    ID: string;
    STA: string;
}

// ============================================================================
// MQTT Configuration
// ============================================================================

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
}

// ============================================================================
// MQTT Command Interfaces
// ============================================================================

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

// ============================================================================
// MQTT State Payloads
// ============================================================================

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

// ============================================================================
// Room Mapping Configuration
// ============================================================================

export interface RoomDevice {
    deviceId: string;
    deviceName?: string;
}

export interface RoomConfig {
    roomName: string;
    devices?: RoomDevice[];
}

export interface RoomMappingConfig {
    enabled: boolean;
    rooms?: RoomConfig[];
}

// ============================================================================
// Type Guards
// ============================================================================

export function isKseniaLight(device: KseniaDevice): device is KseniaLight {
    return device.type === 'light';
}

export function isKseniaCover(device: KseniaDevice): device is KseniaCover {
    return device.type === 'cover';
}

export function isKseniaThermostat(device: KseniaDevice): device is KseniaThermostat {
    return device.type === 'thermostat';
}

export function isKseniaSensor(device: KseniaDevice): device is KseniaSensor {
    return device.type === 'sensor';
}

export function isKseniaZone(device: KseniaDevice): device is KseniaZone {
    return device.type === 'zone';
}

export function isKseniaScenario(device: KseniaDevice): device is KseniaScenario {
    return device.type === 'scenario';
}

/**
 * Type guard for checking if an unknown value is a valid MQTT light command
 */
export function isMqttLightCommand(cmd: unknown): cmd is MqttLightCommand {
    if (typeof cmd !== 'object' || cmd === null) {
        return false;
    }
    const obj = cmd as Record<string, unknown>;
    return (
        (obj.on === undefined || typeof obj.on === 'boolean') &&
        (obj.brightness === undefined || typeof obj.brightness === 'number')
    );
}

/**
 * Type guard for checking if an unknown value is a valid MQTT cover command
 */
export function isMqttCoverCommand(cmd: unknown): cmd is MqttCoverCommand {
    if (typeof cmd !== 'object' || cmd === null) {
        return false;
    }
    const obj = cmd as Record<string, unknown>;
    return obj.position === undefined || typeof obj.position === 'number';
}

/**
 * Type guard for checking if an unknown value is a valid MQTT thermostat command
 */
export function isMqttThermostatCommand(cmd: unknown): cmd is MqttThermostatCommand {
    if (typeof cmd !== 'object' || cmd === null) {
        return false;
    }
    const obj = cmd as Record<string, unknown>;
    const validModes = ['off', 'heat', 'cool', 'auto'];
    return (
        (obj.targetTemperature === undefined || typeof obj.targetTemperature === 'number') &&
        (obj.mode === undefined || (typeof obj.mode === 'string' && validModes.includes(obj.mode)))
    );
}

/**
 * Type guard for checking if an unknown value is a valid MQTT scenario command
 */
export function isMqttScenarioCommand(cmd: unknown): cmd is MqttScenarioCommand {
    if (typeof cmd !== 'object' || cmd === null) {
        return false;
    }
    const obj = cmd as Record<string, unknown>;
    return obj.active === undefined || typeof obj.active === 'boolean';
}