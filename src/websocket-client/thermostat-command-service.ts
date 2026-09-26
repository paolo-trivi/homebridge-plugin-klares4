import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import { stripDevicePrefix } from '../device-id';
import type { ThermostatMode } from '../thermostat-mode';
import type { CommandDispatcher } from '../websocket/command-dispatcher';
import { clampValue } from '../websocket/device-state-projector';
import { ThermostatSeasonTracker } from './thermostat-write-payload';
import { buildThermostatModeCommandPayload, buildThermostatSetpointCommandPayload } from './thermostat-command-payload';
import { findDegradedCommandIdConflict, resolveThermostatCommandId } from './thermostat-command-id-resolver';
import type { KseniaCommandPayload, SendCommandOptions, WebSocketClientState } from './types';

export type SendKseniaCommand = (
    cmd: string,
    payloadType: string,
    payload: KseniaCommandPayload,
    options?: SendCommandOptions,
) => Promise<unknown>;

interface ThermostatCommandServiceDeps {
    state: WebSocketClientState;
    log: Logger;
    logLevel: LogLevel;
    commandDispatcher: Pick<CommandDispatcher, 'enqueueDeviceCommand'>;
    send: SendKseniaCommand;
}

/** WRITE_CFG CFG_THERMOSTATS commands: cfg id resolution, season and payload shaping. */
export class ThermostatCommandService {
    private static readonly THERMOSTAT_ACK_TIMEOUT_MS = 2500;
    private readonly thermostatSeasons = new ThermostatSeasonTracker();

    constructor(private readonly deps: ThermostatCommandServiceDeps) {}

    public async setThermostatMode(thermostatId: string, mode: ThermostatMode): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const outputThermostatId = stripDevicePrefix(thermostatId);
        const commandThermostatId = await this.resolveThermostatCommandId(outputThermostatId);
        await this.deps.commandDispatcher.enqueueDeviceCommand(thermostatId, async (): Promise<void> => {
            const cfgEntry = buildThermostatModeCommandPayload(
                commandThermostatId,
                mode,
                this.deps.state.thermostatCfgById.get(commandThermostatId),
            );
            await this.writeThermostatCfg(cfgEntry);
            this.deps.state.thermostatCfgById.set(commandThermostatId, cfgEntry);
            this.thermostatSeasons.recordAcknowledged(commandThermostatId, cfgEntry);
        });
    }

    public async setThermostatTemperature(thermostatId: string, temperature: number): Promise<void> {
        if (!this.deps.state.idLogin) throw new Error('Not connected');
        const safeTemperature = clampValue(temperature, 5, 40);
        const outputThermostatId = stripDevicePrefix(thermostatId);
        const commandThermostatId = await this.resolveThermostatCommandId(outputThermostatId);
        await this.deps.commandDispatcher.enqueueDeviceCommand(thermostatId, async (): Promise<void> => {
            await this.primeThermostatConfigCache(commandThermostatId);
            const existingCfg = this.deps.state.thermostatCfgById.get(commandThermostatId);
            // By output id: the realtime snapshot map is keyed by DOMUS sensor id,
            // which on swapped pairs is another thermostat's cfg id.
            const realtime = this.deps.state.thermostatRealtimeSeasonByOutputId?.get(outputThermostatId);
            const cfgEntry = buildThermostatSetpointCommandPayload({
                systemThermostatId: commandThermostatId,
                temperature: safeTemperature,
                season: this.thermostatSeasons.resolve(commandThermostatId, realtime, existingCfg),
                existingCfg,
            });
            await this.writeThermostatCfg(cfgEntry);
            this.deps.state.thermostatCfgById.set(commandThermostatId, cfgEntry);
            this.thermostatSeasons.recordAcknowledged(commandThermostatId, cfgEntry);
        });
    }

    private async writeThermostatCfg(cfgEntry: Record<string, unknown>): Promise<void> {
        await this.deps.send('WRITE_CFG', 'CFG_ALL', {
            ID_LOGIN: 'true',
            CFG_THERMOSTATS: [cfgEntry],
        }, {
            awaitResponse: true,
            responseCmds: ['WRITE_CFG_RES'],
            timeoutMs: ThermostatCommandService.THERMOSTAT_ACK_TIMEOUT_MS,
            requirePositiveResult: true,
            allowGenericErrorFallback: true,
        });
    }

    private async resolveThermostatCommandId(outputThermostatId: string): Promise<string> {
        if (
            this.deps.state.thermostatProgramById.size === 0
            && !this.deps.state.missingThermostatProgramWarningOutputIds.has(outputThermostatId)
        ) {
            this.deps.log.warn(
                `PRG_THERMOSTATS unavailable for thermostat_${outputThermostatId}, using degraded command fallback`,
            );
            this.deps.state.missingThermostatProgramWarningOutputIds.add(outputThermostatId);
        }

        const hasProgramMapping = this.deps.state.thermostatProgramById.size > 0;
        const manualCommandId = this.getManualThermostatCommandId(outputThermostatId);
        const resolvedCommandId = await resolveThermostatCommandId({
            outputThermostatId,
            hasProgramMapping,
            cachedCommandId: this.deps.state.thermostatCommandIdByOutputId.get(outputThermostatId),
            manualCommandId,
            programCommandId: this.deps.state.thermostatProgramIdByOutputId.get(outputThermostatId),
            mappedDomusSensorId: this.deps.state.thermostatToDomus.get(outputThermostatId),
            primeConfig: (candidateId): Promise<boolean> => this.primeThermostatConfigCache(candidateId),
            rememberCommandId: (resolvedCommandId): void => { this.deps.state.thermostatCommandIdByOutputId.set(outputThermostatId, resolvedCommandId); },
            onResolvedAlias: (resolvedCommandId): void => this.deps.log.info(`Thermostat command ID resolved thermostat_${outputThermostatId} -> ${resolvedCommandId}`),
        });
        this.logThermostatRouting(outputThermostatId);
        if (!hasProgramMapping && manualCommandId === undefined) {
            this.assertUnambiguousDegradedCommandId(outputThermostatId, resolvedCommandId);
        }
        return resolvedCommandId;
    }

    /** Refuses a guessed cfg id that may belong to another thermostat (see findDegradedCommandIdConflict). */
    private assertUnambiguousDegradedCommandId(outputThermostatId: string, commandId: string): void {
        const routes = [...(this.deps.state.devices?.values() ?? [])]
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
        throw new Error(`Thermostat cfg id for thermostat_${outputThermostatId} is ambiguous: set domusThermostat.manualCommandPairs`);
    }

    private logThermostatRouting(outputThermostatId: string): void {
        if (this.deps.logLevel < LogLevel.DEBUG) {
            return;
        }
        const configId = this.deps.state.thermostatProgramIdByOutputId.get(outputThermostatId)
            ?? this.deps.state.thermostatCommandIdByOutputId.get(outputThermostatId)
            ?? outputThermostatId;
        const domusSensorId = this.deps.state.thermostatToDomus.get(outputThermostatId) ?? 'NA';
        const source = this.deps.state.thermostatProgramIdByOutputId.has(outputThermostatId) ? 'prg_thermostats' : 'fallback';
        this.deps.log.debug(`thermostat_${outputThermostatId} => cfg:${configId} domus:${domusSensorId} source:${source}`);
    }

    private getManualThermostatCommandId(outputThermostatId: string): string | undefined {
        const pair = this.deps.state.domusThermostatConfig.manualCommandPairs.find(
            (item) => stripDevicePrefix(item.thermostatOutputId) === outputThermostatId,
        );
        return pair ? stripDevicePrefix(pair.commandThermostatId) : undefined;
    }

    private async primeThermostatConfigCache(systemThermostatId: string): Promise<boolean> {
        if (this.deps.state.thermostatCfgById.has(systemThermostatId)) return true;
        try {
            await this.deps.send('READ', 'CFG_THERMOSTATS', {
                ID_LOGIN: 'true',
                ID_READ: systemThermostatId,
                ID_ITEMS_RANGE: [systemThermostatId, systemThermostatId],
            }, {
                awaitResponse: true,
                responseCmds: ['READ_RES'],
                responsePayloadTypes: ['CFG_THERMOSTATS'],
                timeoutMs: ThermostatCommandService.THERMOSTAT_ACK_TIMEOUT_MS,
            });
            return this.deps.state.thermostatCfgById.has(systemThermostatId);
        } catch (error: unknown) {
            if (this.deps.state.thermostatCfgById.has(systemThermostatId)) return true;
            if (this.deps.logLevel >= LogLevel.DEBUG) this.deps.log.debug(`Unable to read CFG_THERMOSTATS for thermostat ${systemThermostatId}: ${error instanceof Error ? error.message : String(error)}`);
            await new Promise((resolve): void => { setTimeout(resolve, 150); });
            if (this.deps.state.thermostatCfgById.has(systemThermostatId)) return true;
            return false;
        }
    }
}
