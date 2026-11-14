import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import type {
    KseniaDevice,
    KseniaOutputData,
    KseniaOutputStatusRaw,
    KseniaProgramThermostatRaw,
} from '../types';
import { determineOutputType, outputCategory } from '../websocket/output-classifier';
import { normalizeDomusSensorId } from './domus-thermostat-mapper';
import { refreshDomusThermostatMapping } from './domus-thermostat-mapping-runtime';
import { handleCfgChangeNotification, recordCfgRead } from './thermostat-cfg-freshness';
import { applyThermostatConfigSnapshot } from './thermostat-config-sync';
import type { ThermostatStatusUpdater } from './thermostat-status-updater';
import type { WebSocketClientState } from './types';

export interface ThermostatReadHandlerDeps {
    state: WebSocketClientState;
    log: Logger;
    logLevel: LogLevel;
    debugEnabled: boolean;
    thermostatStatusUpdater: ThermostatStatusUpdater;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
}

/**
 * Thermostat side of the discovery reads: thermostat outputs of MULTI_TYPES,
 * `PRG_THERMOSTATS` (programs: output ↔ cfg id ↔ DOMUS sensor),
 * `CFG_THERMOSTATS` (cfg cache used by writes), the cfg → status sync and the
 * panel's cfg change notifications.
 */
export class ThermostatReadHandler {
    constructor(private readonly deps: ThermostatReadHandlerDeps) {}

    /** Called for every output of a MULTI_TYPES read, before it is parsed. */
    public recordOutput(output: KseniaOutputData): void {
        const type = determineOutputType(outputCategory(output), output.MOD);
        if (type !== 'thermostat') return;
        this.deps.state.thermostatOutputs.set(output.ID, output);
        if (this.deps.debugEnabled) {
            this.deps.log.debug(
                `Thermostat found - ID: ${output.ID}, DES: ${output.DES}, TYPE: ${output.TYPE}, CAT: ${output.CAT}`,
            );
        }
    }

    /** Called once a MULTI_TYPES read has been fully processed. */
    public afterMultiTypes(): void {
        this.refreshDomusThermostatMapping();
        this.applyOutputRoles();
        this.deps.thermostatStatusUpdater.applyPendingTemperatureStatuses();
    }

    /**
     * Only the cfg entries of this response are applied to the thermostats'
     * state: a cfg cached by an earlier session is never replayed over it.
     * `prgCheck` is the response's `PRG_CHECK`, the panel's change counter.
     */
    public handleCfgThermostats(entries: unknown[], prgCheck?: unknown): void {
        const readIds = new Set<string>();
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const thermostatId = String((entry as Record<string, unknown>).ID ?? '');
            if (!thermostatId) {
                continue;
            }
            this.deps.state.thermostatCfgById.set(thermostatId, entry as Record<string, unknown>);
            readIds.add(thermostatId);
        }
        recordCfgRead(this.deps.state, [...readIds], prgCheck);
        if (this.deps.logLevel >= LogLevel.DEBUG) {
            this.deps.log.debug(
                `Cached thermostat configs: ${this.deps.state.thermostatCfgById.size}`,
            );
        }
        applyThermostatConfigSnapshot({
            state: this.deps.state,
            emitDeviceStatusUpdate: (device): void => this.deps.emitDeviceStatusUpdate(device),
            cfgIds: readIds,
        });
        this.deps.thermostatStatusUpdater.applyPendingTemperatureStatuses();
    }

    public handlePrgThermostats(entries: KseniaProgramThermostatRaw[]): void {
        this.cacheProgramThermostats(entries);
        this.refreshDomusThermostatMapping();
        this.applyOutputRoles();
        this.deps.thermostatStatusUpdater.applyPendingTemperatureStatuses();
    }

    /**
     * NOT_MASK_UNSOLICITED / NM_CHANGES (`PAYLOAD.PRG_CHECK`), sent by the panel
     * about a second after a cfg change. Drops the cfg cache when the change
     * was not ours, so the next write reads the cfg again.
     */
    public handleChangeNotification(payload: unknown): void {
        const prgCheck = payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>).PRG_CHECK
            : undefined;
        if (handleCfgChangeNotification(this.deps.state, prgCheck)) {
            this.deps.log.debug('Panel configuration changed elsewhere: thermostat cfg cache cleared');
        }
    }

    /** Debug trace of the initial STATUS_OUTPUTS entries that belong to a thermostat. */
    public logInitialThermostatStates(outputs: KseniaOutputStatusRaw[]): void {
        if (!this.deps.debugEnabled) return;
        outputs.forEach((output: KseniaOutputStatusRaw): void => {
            const thermostatDevice = this.deps.state.devices.get(`thermostat_${output.ID}`);
            if (thermostatDevice) {
                this.deps.log.debug(`Initial thermostat state ${output.ID}: ${JSON.stringify(output)}`);
            }
        });
    }

    private refreshDomusThermostatMapping(): void {
        refreshDomusThermostatMapping(this.deps.state, this.deps.log);
    }

    private cacheProgramThermostats(entries: KseniaProgramThermostatRaw[]): void {
        this.deps.state.thermostatProgramById.clear();
        this.deps.state.thermostatProgramIdByOutputId.clear();
        this.deps.state.domusSensorIdByThermostatProgramId.clear();

        for (const entry of entries) {
            const thermostatProgramId = String(entry.ID ?? '');
            if (!thermostatProgramId) {
                continue;
            }

            this.deps.state.thermostatProgramById.set(thermostatProgramId, entry);
            const rawSensorId = entry.PERIPH?.PID;
            const sensorId = rawSensorId ? normalizeDomusSensorId(rawSensorId) : undefined;
            if (sensorId) {
                this.deps.state.domusSensorIdByThermostatProgramId.set(thermostatProgramId, sensorId);
            }

            for (const outputId of [entry.HEATING_OUT, entry.COOLING_OUT]) {
                if (!outputId || outputId === 'NU') {
                    continue;
                }
                this.deps.state.thermostatProgramIdByOutputId.set(String(outputId), thermostatProgramId);
            }
        }

        if (this.deps.logLevel >= LogLevel.DEBUG) {
            for (const [outputId, thermostatProgramId] of this.deps.state.thermostatProgramIdByOutputId.entries()) {
                const sensorId = this.deps.state.domusSensorIdByThermostatProgramId.get(thermostatProgramId) ?? 'NA';
                this.deps.log.debug(`thermostat_${outputId} => cfg:${thermostatProgramId} domus:${sensorId} source:prg_thermostats`);
            }
        }
    }

    /** `status.outputRole` from the programs: which output heats and which cools. */
    private applyOutputRoles(): void {
        const roles = new Map<string, 'heating' | 'cooling'>();
        for (const program of this.deps.state.thermostatProgramById.values()) {
            if (program.HEATING_OUT && program.HEATING_OUT !== 'NU') roles.set(String(program.HEATING_OUT), 'heating');
            if (program.COOLING_OUT && program.COOLING_OUT !== 'NU') roles.set(String(program.COOLING_OUT), 'cooling');
        }
        for (const [outputId, role] of roles) {
            const device = this.deps.state.devices.get(`thermostat_${outputId}`);
            if (device?.type === 'thermostat') device.status.outputRole = role;
        }
    }
}
