import type { Logger } from 'homebridge';
import { LogLevel } from '../log-levels';
import { updateThermostatStatus } from '../thermostat-state';
import type { KseniaDevice, KseniaThermostat } from '../types';
import {
    applyAcknowledgedWrite,
    buildThermostatWritePayload,
    type ThermostatWriteIntent,
} from './thermostat-command-payload';
import { ThermostatRoutingError } from './thermostat-command-id-resolver';
import { cfgFreshness, recordOwnCfgWrite } from './thermostat-cfg-freshness';
import type { ThermostatWriteBatch } from './thermostat-write-batcher';
import {
    asSeason,
    seasonOfMode,
    ThermostatSeasonTracker,
    type SeasonObservation,
    type ThermostatSeason,
} from './thermostat-write-payload';
import type { KseniaCommandPayload, SendCommandOptions, WebSocketClientState } from './types';

export type SendKseniaCommand = (
    cmd: string,
    payloadType: string,
    payload: KseniaCommandPayload,
    options?: SendCommandOptions,
) => Promise<unknown>;

export interface ThermostatWriteExecutorDeps {
    state: WebSocketClientState;
    log: Logger;
    logLevel: LogLevel;
    send: SendKseniaCommand;
    /** The realtime channel to HomeKit, Matter and MQTT. Without it the realtime confirms the write instead. */
    emitDeviceStatusUpdate?: (device: KseniaDevice) => void;
}

/** Reads the cfg, builds the partial WRITE_CFG and, once acknowledged, propagates what the panel accepted. */
export class ThermostatWriteExecutor {
    private readonly seasons = new ThermostatSeasonTracker();

    constructor(private readonly deps: ThermostatWriteExecutorDeps) {}

    /** The cfg is in the cache, or has just been read from the panel. */
    public async primeConfig(cfgId: string): Promise<boolean> {
        return this.deps.state.thermostatCfgById.has(cfgId) || this.readConfig(cfgId);
    }

    public async execute(batch: ThermostatWriteBatch): Promise<void> {
        const { cfgId } = batch;
        // A setpoint carries the season block as read: it must be the panel's current one.
        const needsRead = batch.intent.temperature !== undefined || !this.deps.state.thermostatCfgById.has(cfgId);
        if (needsRead && !await this.readConfig(cfgId)) {
            throw new ThermostatRoutingError(`Thermostat cfg ${cfgId} could not be read from the panel before the write; write refused`);
        }
        batch.seal();
        const intent: ThermostatWriteIntent = { ...batch.intent };
        const cfg = this.deps.state.thermostatCfgById.get(cfgId);
        const season = seasonOfMode(intent.mode) ?? this.seasons.resolve(cfgId, this.seasonObservations(cfgId, cfg));
        const payload = buildThermostatWritePayload({ cfgId, intent, season, cfg });
        await this.deps.send('WRITE_CFG', 'CFG_ALL', {
            ID_LOGIN: 'true',
            CFG_THERMOSTATS: [payload],
        }, {
            awaitResponse: true,
            responseCmds: ['WRITE_CFG_RES'],
            requirePositiveResult: true,
            allowGenericErrorFallback: true,
        });
        this.onAcknowledged(cfgId, intent, payload, season);
    }

    /** Output ids whose writes go to `cfgId`. */
    public outputsOfCfg(cfgId: string): string[] {
        const outputs = new Set<string>();
        for (const [outputId, id] of this.deps.state.thermostatProgramIdByOutputId) if (id === cfgId) outputs.add(outputId);
        for (const [outputId, id] of this.deps.state.thermostatCommandIdByOutputId) if (id === cfgId) outputs.add(outputId);
        return [...outputs];
    }

    private async readConfig(cfgId: string): Promise<boolean> {
        // Dropped first, so only the panel's answer to this read can satisfy the check below.
        this.deps.state.thermostatCfgById.delete(cfgId);
        try {
            await this.deps.send('READ', 'CFG_THERMOSTATS', {
                ID_LOGIN: 'true',
                ID_READ: cfgId,
                ID_ITEMS_RANGE: [cfgId, cfgId],
            }, {
                awaitResponse: true,
                responseCmds: ['READ_RES'],
                responsePayloadTypes: ['CFG_THERMOSTATS'],
            });
        } catch (error: unknown) {
            this.deps.log.warn(`Unable to read CFG_THERMOSTATS ${cfgId}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
        return this.deps.state.thermostatCfgById.has(cfgId);
    }

    private seasonObservations(cfgId: string, cfg: Record<string, unknown> | undefined): SeasonObservation[] {
        const observations: SeasonObservation[] = [];
        const readAt = cfgFreshness(this.deps.state).readAt.get(cfgId);
        if (readAt !== undefined) observations.push({ season: asSeason(cfg?.ACT_SEA), at: readAt });
        for (const outputId of this.outputsOfCfg(cfgId)) {
            const realtime = this.deps.state.thermostatRealtimeSeasonByOutputId.get(outputId);
            if (realtime) observations.push({ season: realtime.season, at: realtime.updatedAt });
        }
        return observations;
    }

    private onAcknowledged(
        cfgId: string,
        intent: ThermostatWriteIntent,
        payload: Record<string, unknown>,
        season: ThermostatSeason,
    ): void {
        const state = this.deps.state;
        const cached = applyAcknowledgedWrite(state.thermostatCfgById.get(cfgId), payload);
        if (cached) state.thermostatCfgById.set(cfgId, cached);
        recordOwnCfgWrite(state);
        this.seasons.recordAcknowledged(cfgId, asSeason(payload.ACT_SEA));
        const at = Date.now();
        for (const outputId of this.outputsOfCfg(cfgId)) {
            const device = state.devices.get(`thermostat_${outputId}`);
            if (!device || device.type !== 'thermostat') continue;
            device.status.acknowledged = { mode: intent.mode, targetTemperature: intent.temperature, at };
            this.propagate(device, intent, season);
        }
        if (this.deps.logLevel >= LogLevel.DEBUG) {
            this.deps.log.debug(`WRITE_CFG cfg ${cfgId} acknowledged: ${Object.keys(payload).join(',')}`);
        }
    }

    /**
     * The acknowledged values reach HomeKit, Matter and MQTT through the same
     * event as a realtime change. A setpoint is shown only when it is the live
     * one (MAN, written in the season of the mode): in AUTO or OFF the panel
     * keeps its own target and the realtime would contradict it.
     */
    private propagate(device: KseniaThermostat, intent: ThermostatWriteIntent, season: ThermostatSeason): void {
        const emit = this.deps.emitDeviceStatusUpdate;
        if (!emit) return;
        const mode = intent.mode ?? device.status.mode;
        const live = (mode === 'heat' || mode === 'cool') && seasonOfMode(mode) === season;
        const changed = updateThermostatStatus(device, {
            mode: intent.mode,
            season: seasonOfMode(intent.mode),
            targetTemperature: live ? intent.temperature : undefined,
        });
        if (changed) emit(device);
    }
}
