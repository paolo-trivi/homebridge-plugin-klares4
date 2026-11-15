import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import { stripDevicePrefix } from '../device-id';
import type { ThermostatMode } from '../thermostat-mode';
import type { KseniaDevice } from '../types';
import type { CommandDispatcher } from '../websocket/command-dispatcher';
import { clampValue } from '../websocket/device-state-projector';
import { judgeDegradedGuess, type DegradedGuessVerdict } from './thermostat-degraded-guess';
import {
    findDegradedCommandIdConflict,
    resolveThermostatCommandId,
    ThermostatRoutingError,
} from './thermostat-command-id-resolver';
import { ThermostatWriteBatcher } from './thermostat-write-batcher';
import { ThermostatWriteExecutor, type SendKseniaCommand } from './thermostat-write-executor';
import type { WebSocketClientState } from './types';

export type { SendKseniaCommand } from './thermostat-write-executor';

const THERMOSTAT_MODES: readonly ThermostatMode[] = ['off', 'heat', 'cool', 'auto'];

interface ThermostatCommandServiceDeps {
    state: WebSocketClientState;
    log: Logger;
    logLevel: LogLevel;
    commandDispatcher: Pick<CommandDispatcher, 'enqueueDeviceCommand'>;
    send: SendKseniaCommand;
    /** How long a write may wait in its cfg queue before it is refused instead of sent late. */
    commandTimeoutMs?: number;
    /** Realtime status channel: an acknowledged write reaches HomeKit, Matter and MQTT through it. */
    emitDeviceStatusUpdate?: (device: KseniaDevice) => void;
    /** How long a write waits for a companion command (mode + setpoint of a scene). Default 50 ms. */
    writeCoalesceMs?: number;
}

/**
 * WRITE_CFG CFG_THERMOSTATS commands: validation, cfg id resolution, one
 * serialized and coalesced write per cfg id. The ACK timeout is the client's
 * `commandTimeoutMs`, like every other command.
 */
export class ThermostatCommandService {
    private readonly executor: ThermostatWriteExecutor;
    private readonly batcher: ThermostatWriteBatcher;

    constructor(private readonly deps: ThermostatCommandServiceDeps) {
        this.executor = new ThermostatWriteExecutor(deps);
        this.batcher = new ThermostatWriteBatcher({
            // Serial: commands are merged before they are queued, so the one
            // waiting is already the latest intent and nothing is superseded.
            enqueue: (key, task) => deps.commandDispatcher.enqueueDeviceCommand(key, task, {
                policy: 'serial',
                maxWaitMs: deps.commandTimeoutMs ?? 8000,
            }),
            execute: (batch) => this.executor.execute(batch),
            coalesceMs: deps.writeCoalesceMs ?? 50,
        });
    }

    public async setThermostatMode(thermostatId: string, mode: ThermostatMode): Promise<void> {
        if (!THERMOSTAT_MODES.includes(mode)) throw new TypeError(`Invalid thermostat mode: ${String(mode)}`);
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const cfgId = await this.resolveThermostatCommandId(stripDevicePrefix(thermostatId));
        await this.batcher.submit(cfgId, { mode });
    }

    public async setThermostatTemperature(thermostatId: string, temperature: number): Promise<void> {
        if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
            throw new TypeError(`Invalid thermostat setpoint: ${String(temperature)}`);
        }
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const safeTemperature = clampValue(temperature, 5, 40);
        const cfgId = await this.resolveThermostatCommandId(stripDevicePrefix(thermostatId));
        await this.batcher.submit(cfgId, { temperature: safeTemperature });
    }

    private async resolveThermostatCommandId(outputThermostatId: string): Promise<string> {
        const state = this.deps.state;
        if (state.thermostatProgramById.size === 0 && !state.missingThermostatProgramWarningOutputIds.has(outputThermostatId)) {
            this.deps.log.warn(`PRG_THERMOSTATS unavailable for thermostat_${outputThermostatId}, using degraded command fallback`);
            state.missingThermostatProgramWarningOutputIds.add(outputThermostatId);
        }
        const sensorId = state.thermostatToDomus.get(outputThermostatId);
        let resolved;
        try {
            resolved = await resolveThermostatCommandId({
                outputThermostatId,
                hasProgramMapping: state.thermostatProgramById.size > 0,
                cachedCommandId: state.thermostatCommandIdByOutputId.get(outputThermostatId),
                manualCommandId: this.getManualThermostatCommandId(outputThermostatId),
                programCommandId: state.thermostatProgramIdByOutputId.get(outputThermostatId),
                mappedDomusSensorId: sensorId,
                primeConfig: (candidateId) => this.executor.primeConfig(candidateId),
                verifyGuess: (candidateId) => this.verifyGuess(sensorId, outputThermostatId, candidateId),
                rememberCommandId: (id): void => { state.thermostatCommandIdByOutputId.set(outputThermostatId, id); },
                onResolvedAlias: (id): void => {
                    if (this.deps.logLevel >= LogLevel.DEBUG) this.deps.log.debug(`Thermostat command ID resolved thermostat_${outputThermostatId} -> ${id}`);
                },
            });
        } catch (error: unknown) {
            if (error instanceof ThermostatRoutingError) this.deps.log.error(error.message);
            throw error;
        }
        this.logThermostatRouting(outputThermostatId, resolved.id, resolved.source);
        if (resolved.source === 'degraded') this.assertUnambiguousDegradedCommandId(outputThermostatId, resolved.id);
        return resolved.id;
    }

    /** Refuses a guessed cfg id that may belong to another thermostat (see findDegradedCommandIdConflict). */
    private assertUnambiguousDegradedCommandId(outputThermostatId: string, commandId: string): void {
        const routes = [...this.deps.state.devices.values()]
            .filter((device) => device.type === 'thermostat')
            .map((device) => {
                const outputId = stripDevicePrefix(device.id);
                return { outputId, sensorId: this.deps.state.thermostatToDomus.get(outputId) };
            });
        const sensorId = this.deps.state.thermostatToDomus.get(outputThermostatId);
        const conflict = findDegradedCommandIdConflict(commandId, { outputId: outputThermostatId, sensorId }, routes);
        if (conflict === undefined) return;
        this.deps.log.error(
            `thermostat_${outputThermostatId}: write refused. Without PRG_THERMOSTATS the cfg id ${commandId} `
            + `is guessed from ${sensorId ? `DOMUS sensor ${sensorId}` : 'the output id'} and may belong to `
            + `thermostat_${conflict}. Set domusThermostat.manualCommandPairs, e.g. `
            + `{ "thermostatOutputId": "${outputThermostatId}", "commandThermostatId": "<cfg id>" }.`,
        );
        throw new ThermostatRoutingError(`Thermostat cfg id for thermostat_${outputThermostatId} is ambiguous: set domusThermostat.manualCommandPairs`);
    }

    /**
     * A guessed cfg id: vouched for by another output on the same sensor whose
     * guess was verified discriminatingly, or judged against every cfg on the
     * panel, read again for the purpose (judgeDegradedGuess).
     */
    private async verifyGuess(sensorId: string | undefined, outputId: string, candidateId: string): Promise<DegradedGuessVerdict> {
        if (this.isVerifiedForSensor(sensorId, candidateId)) return { accepted: true, remember: true };
        if (!await this.executor.readAllConfigs()) {
            return { accepted: false, reason: 'the panel\'s thermostat cfgs could not be read to check it' };
        }
        const state = this.deps.state;
        return judgeDegradedGuess(candidateId, sensorId ?? outputId, state.thermostatCfgById, state.thermostatRealtimeSnapshotById);
    }

    /** Outputs measuring one sensor share its cfg: one already verified for that sensor vouches for it. */
    private isVerifiedForSensor(sensorId: string | undefined, candidateId: string): boolean {
        if (sensorId === undefined) return false;
        for (const [outputId, cfgId] of this.deps.state.thermostatCommandIdByOutputId) {
            if (cfgId === candidateId && this.deps.state.thermostatToDomus.get(outputId) === sensorId) return true;
        }
        return false;
    }

    private logThermostatRouting(outputThermostatId: string, cfgId: string, source: string): void {
        if (this.deps.logLevel < LogLevel.DEBUG) return;
        const domusSensorId = this.deps.state.thermostatToDomus.get(outputThermostatId) ?? 'NA';
        this.deps.log.debug(`thermostat_${outputThermostatId} => cfg:${cfgId} domus:${domusSensorId} source:${source}`);
    }

    private getManualThermostatCommandId(outputThermostatId: string): string | undefined {
        const pair = this.deps.state.domusThermostatConfig.manualCommandPairs.find(
            (item) => stripDevicePrefix(item.thermostatOutputId) === outputThermostatId,
        );
        return pair ? stripDevicePrefix(pair.commandThermostatId) : undefined;
    }
}
