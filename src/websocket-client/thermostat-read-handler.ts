import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import type {
    KseniaDevice,
    KseniaOutputData,
    KseniaOutputStatusRaw,
    KseniaProgramThermostatRaw,
} from '../types';
import { determineOutputType, outputCategory } from '../websocket/output-classifier';
import { stripDevicePrefix } from '../device-id';
import { deriveThermostatOutputRole } from '../thermostat-role';
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
        this.deps.state.thermostatProgramsSettled = true;
        this.cacheProgramThermostats(entries);
        this.refreshDomusThermostatMapping();
        this.applyOutputRoles();
        this.deps.thermostatStatusUpdater.applyPendingTemperatureStatuses();
    }

    /**
     * The panel refused `PRG_THERMOSTATS` (some panels never provide it): the
     * roles taken from the output names are final.
     */
    public programsUnavailable(): void {
        if (this.deps.state.thermostatProgramsSettled) return;
        this.deps.state.thermostatProgramsSettled = true;
        this.applyOutputRoles();
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

    /**
     * `status.outputRole` of a thermostat from the program that names its
     * output (`HEATING_OUT` / `COOLING_OUT`), else from the panel's own output
     * name. Called before a thermostat is announced, so Matter registers it
     * with its role when the programs are already known (`.ksa` cache, re-login).
     * Returns whether the role changed.
     */
    public applyOutputRole(device: KseniaDevice): boolean {
        if (device.type !== 'thermostat') return false;
        const outputId = stripDevicePrefix(device.id);
        const state = this.deps.state;
        const programId = state.thermostatProgramIdByOutputId.get(outputId);
        const program = programId === undefined ? undefined : state.thermostatProgramById.get(programId);
        const role = deriveThermostatOutputRole(outputId, program, state.thermostatOutputs.get(outputId)?.DES);
        const pending = state.thermostatProgramsSettled ? undefined : true;
        if ((role === undefined || role === device.status.outputRole) && pending === device.status.outputRolePending) return false;
        if (role !== undefined) device.status.outputRole = role;
        if (pending) device.status.outputRolePending = true;
        else delete device.status.outputRolePending;
        return true;
    }

    private applyOutputRoles(): void {
        for (const device of this.deps.state.devices.values()) {
            if (this.applyOutputRole(device)) this.deps.emitDeviceStatusUpdate(device);
        }
    }
}
