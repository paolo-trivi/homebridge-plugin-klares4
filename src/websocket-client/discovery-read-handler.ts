import type { Logger } from 'homebridge';
import type {
    KseniaBusHaData,
    KseniaDevice,
    KseniaOutputData,
    KseniaScenarioData,
    KseniaZoneData,
} from '../types';
import { normalizeDeviceName } from '../websocket/device-state-projector';
import { parseOutputData, parseZoneData } from './device-parsers';
import { adoptDiscoveredDevice } from './discovered-device';
import { normalizeDomusSensorId } from './domus-thermostat-mapper';
import { forEachIsolated } from '../isolation';
import { discoverScenarios } from './scenario-discovery';
import type { StatusUpdater } from './status-updater';
import type { ThermostatReadHandler } from './thermostat-read-handler';
import type { WebSocketClientState } from './types';

export interface DiscoveryReadHandlerDeps {
    state: WebSocketClientState;
    log: Logger;
    exposePartialArmScenarios?: boolean;
    statusUpdater: StatusUpdater;
    thermostats: ThermostatReadHandler;
    emitDeviceDiscovered: (device: KseniaDevice) => void;
}

/**
 * Device discovery from the configuration reads: zones (`ZONES`) and the
 * outputs, scenarios and BUS sensors of `MULTI_TYPES`. Every discovered
 * device gets any status that arrived before it (pending statuses).
 */
export class DiscoveryReadHandler {
    constructor(private readonly deps: DiscoveryReadHandlerDeps) {}

    public handleZones(zones: KseniaZoneData[]): void {
        this.deps.log.info(`Found ${zones.length} zones`);
        forEachIsolated(this.deps.log, 'READ_RES/ZONES zone', zones, (zone: KseniaZoneData): void => {
            const device = adoptDiscoveredDevice(this.deps.state.devices, parseZoneData(zone));
            this.deps.emitDeviceDiscovered(device);
            this.deps.statusUpdater.applyPendingZoneStatus(zone.ID);
        });
    }

    public handleOutputs(outputs: KseniaOutputData[]): void {
        this.deps.log.info(`Found ${outputs.length} outputs`);
        forEachIsolated(this.deps.log, 'READ_RES/MULTI_TYPES OUTPUTS output', outputs, (output: KseniaOutputData): void => {
            this.deps.thermostats.recordOutput(output);
            const parsed = parseOutputData(output);
            if (parsed) {
                const device = adoptDiscoveredDevice(this.deps.state.devices, parsed);
                this.deps.emitDeviceDiscovered(device);
                this.deps.statusUpdater.applyPendingOutputStatus(output.ID);
            }
        });
    }

    public handleScenarios(scenarios: KseniaScenarioData[]): void {
        discoverScenarios(scenarios, {
            state: this.deps.state,
            log: this.deps.log,
            exposePartialArmScenarios: this.deps.exposePartialArmScenarios,
            onDeviceDiscovered: (device): void => this.deps.emitDeviceDiscovered(device),
        });
    }

    public handleBusSensors(sensors: KseniaBusHaData[]): void {
        this.deps.log.info(`Found ${sensors.length} sensors`);
        forEachIsolated(this.deps.log, 'READ_RES/MULTI_TYPES BUS_HAS sensor', sensors, (sensor: KseniaBusHaData): void => {
            const normalizedSensorId = normalizeDomusSensorId(sensor.ID);
            this.deps.state.domusSensors.set(normalizedSensorId, { ...sensor, ID: normalizedSensorId });
            const baseName = normalizeDeviceName(sensor.DES) || `Sensor ${normalizedSensorId}`;

            const tempDevice = adoptDiscoveredDevice(this.deps.state.devices, {
                id: `sensor_temp_${normalizedSensorId}`,
                type: 'sensor',
                name: `${baseName} - Temperatura`,
                description: `${baseName} - Temperatura`,
                status: { sensorType: 'temperature', value: 0, unit: 'C' },
            } as const);
            this.deps.emitDeviceDiscovered(tempDevice);

            const humDevice = adoptDiscoveredDevice(this.deps.state.devices, {
                id: `sensor_hum_${normalizedSensorId}`,
                type: 'sensor',
                name: `${baseName} - Umidita`,
                description: `${baseName} - Umidita`,
                status: { sensorType: 'humidity', value: 50, unit: '%' },
            } as const);
            this.deps.emitDeviceDiscovered(humDevice);

            const lightDevice = adoptDiscoveredDevice(this.deps.state.devices, {
                id: `sensor_light_${normalizedSensorId}`,
                type: 'sensor',
                name: `${baseName} - Luminosita`,
                description: `${baseName} - Luminosita`,
                status: { sensorType: 'light', value: 100, unit: 'lux' },
            } as const);
            this.deps.emitDeviceDiscovered(lightDevice);
            this.deps.statusUpdater.applyPendingSensorStatus(normalizedSensorId);
        });
    }
}
