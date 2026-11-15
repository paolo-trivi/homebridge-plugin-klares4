import type { Logger } from 'homebridge';
import type {
    KseniaBusHaData,
    KseniaDevice,
    KseniaOutputData,
    KseniaScenarioData,
    KseniaZoneData,
    OutputOptIn,
    ScenarioOptIn,
} from '../types';
import { normalizeDeviceName } from '../websocket/device-state-projector';
import { OutputTypeMemory, resolveOutputExposure } from '../websocket/output-classifier';
import { outputOptInTypes, parseOutputData, parseZoneData, scenarioOptInIds } from './device-parsers';
import { adoptDiscoveredDevice } from './discovered-device';
import { ExposureReport, replaceHiddenDevices, type ReadFindings } from './exposure-report';
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
    /** Outputs of an unrecognized category to expose anyway (`exposeOutputs`). */
    exposeOutputs?: readonly OutputOptIn[];
    /** Scenarios of an unrecognized category to expose anyway (`exposeScenarios`). */
    exposeScenarios?: readonly ScenarioOptIn[];
    statusUpdater: StatusUpdater;
    thermostats: ThermostatReadHandler;
    emitDeviceDiscovered: (device: KseniaDevice) => void;
}

/**
 * Device discovery from the configuration reads: zones (`ZONES`) and the
 * outputs, scenarios and BUS sensors of `MULTI_TYPES`. Every discovered
 * device gets any status that arrived before it (pending statuses).
 * Outputs and scenarios go through the fail-closed exposure policy: what it
 * hides never enters `state.devices`, so it is neither exposed nor commanded.
 */
export class DiscoveryReadHandler {
    private readonly report: ExposureReport;
    private readonly outputTypes = new OutputTypeMemory();

    constructor(private readonly deps: DiscoveryReadHandlerDeps) {
        this.report = new ExposureReport(deps.log);
    }

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
        const optIns = outputOptInTypes(this.deps.exposeOutputs);
        const findings: ReadFindings = { hidden: [], ignoredOptIns: [], pinFlagged: [] };
        const listed = new Set<string>();
        forEachIsolated(this.deps.log, 'READ_RES/MULTI_TYPES OUTPUTS output', outputs, (output: KseniaOutputData): void => {
            const panelId = String(output.ID);
            listed.add(panelId);
            this.deps.thermostats.recordOutput(output);
            const exposure = resolveOutputExposure(output, optIns, this.outputTypes);
            if (!exposure.exposed) {
                const name = normalizeDeviceName(output.DES) || `Output ${panelId}`;
                findings.hidden.push({
                    deviceId: `light_${panelId}`,
                    kind: 'output',
                    panelId,
                    name,
                    category: exposure.category,
                    ...(exposure.mode ? { mode: exposure.mode } : {}),
                    optInAllowed: true,
                });
                this.deps.log.debug(`Output ${name} not exposed: category ${exposure.category || 'none'} is not recognized`);
                return;
            }
            if (exposure.source === 'category' && optIns.has(panelId)) {
                findings.ignoredOptIns.push(`exposeOutputs: output ${panelId} is exposed as ${exposure.type} without it`);
            }
            const device = adoptDiscoveredDevice(this.deps.state.devices, parseOutputData(output));
            if (device.type === 'thermostat') this.deps.thermostats.applyOutputRole(device);
            this.deps.emitDeviceDiscovered(device);
            this.deps.statusUpdater.applyPendingOutputStatus(output.ID);
        });
        for (const panelId of optIns.keys()) {
            if (!listed.has(panelId)) findings.ignoredOptIns.push(`exposeOutputs: output ${panelId} is not listed by the panel`);
        }
        replaceHiddenDevices(this.deps.state, 'output', findings.hidden);
        this.report.recordOutputs(findings);
    }

    public handleScenarios(scenarios: KseniaScenarioData[]): void {
        const findings = discoverScenarios(scenarios, {
            state: this.deps.state,
            log: this.deps.log,
            exposePartialArmScenarios: this.deps.exposePartialArmScenarios,
            optInIds: scenarioOptInIds(this.deps.exposeScenarios),
            onDeviceDiscovered: (device): void => this.deps.emitDeviceDiscovered(device),
        });
        replaceHiddenDevices(this.deps.state, 'scenario', findings.hidden);
        this.report.recordScenarios(findings);
        this.report.flush();
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
        // A MULTI_TYPES read without SCENARIOS: report the outputs here.
        this.report.flush();
    }
}
