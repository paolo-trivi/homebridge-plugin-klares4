import type { PlatformConfig } from 'homebridge';

import type { CoverAccessory } from '../accessories/cover-accessory';
import type { GateAccessory } from '../accessories/gate-accessory';
import type { LightAccessory } from '../accessories/light-accessory';
import type { ScenarioAccessory } from '../accessories/scenario-accessory';
import type { SensorAccessory } from '../accessories/sensor-accessory';
import type { ThermostatAccessory } from '../accessories/thermostat-accessory';
import type { ZoneAccessory } from '../accessories/zone-accessory';
import type { DomusThermostatConfig, MqttConfig, RoomMappingConfig } from '../types';

export type AccessoryHandler =
    | LightAccessory
    | CoverAccessory
    | GateAccessory
    | SensorAccessory
    | ZoneAccessory
    | ThermostatAccessory
    | ScenarioAccessory;

export interface Lares4Config extends PlatformConfig {
    ip?: string;
    sender?: string;
    pin?: string;
    https?: boolean;
    port?: number;
    debug?: boolean;
    logLevel?: number;
    maxSeconds?: number;
    reconnectInterval?: number;
    heartbeatInterval?: number;
    commandTimeoutMs?: number;
    allowInsecureTls?: boolean;
    excludeZones?: string[];
    excludeOutputs?: string[];
    excludeSensors?: string[];
    excludeScenarios?: string[];
    customNames?: {
        zones?: Record<string, string>;
        outputs?: Record<string, string>;
        sensors?: Record<string, string>;
        scenarios?: Record<string, string>;
    };
    scenarioAutoOffDelay?: number;
    coverStepSize?: number;
    temperatureDefaults?: {
        target?: number;
        min?: number;
        max?: number;
        step?: number;
    };
    devicesSummaryDelay?: number;
    mqtt?: MqttConfig;
    roomMapping?: RoomMappingConfig;
    domusThermostat?: DomusThermostatConfig;
    generateDebugFile?: boolean;
}

export interface DeviceListItem {
    id: string;
    name: string;
    type: string;
    description: string;
    fullId: string;
}

export interface DevicesList {
    zones: DeviceListItem[];
    outputs: DeviceListItem[];
    sensors: DeviceListItem[];
    scenarios: DeviceListItem[];
    lastUpdated: string;
}
