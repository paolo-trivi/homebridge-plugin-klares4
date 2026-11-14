import type { API, Logger, MatterAccessory } from 'homebridge';
import type { KseniaDevice, KseniaThermostat } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import { hasObservedState, mergeKnownState } from '../device-observation';
import { deviceToMatterAccessory, mapThermostatAsTemperatureSensor } from './matter-device-mapper';
import type { MatterFallbackStore } from './matter-fallback-store';
import { needsDimmableUpgrade, upgradeToDimmableLight, withCachedDimmable } from './matter-light-capability';
import type { MatterNameService } from './matter-name-service';
import type { MatterPruneTracker } from './matter-prune-tracker';
import type { MatterReachability } from './matter-reachability';
import { probeUntilQueryable, RegisterSettlement } from './matter-register-probe';
import { MatterRegistrationGate } from './matter-registration-gate';
import {
    handleMissingRegisteredAccessory, handleRegisterFailure, isFallbackTemperatureSensor, type MatterRegistration,
} from './matter-registration-recovery';
import { enqueueDeviceState, liveNodeLabel, logRegisterRequested, refreshRegistrationMetadata, type CachedEndpointLabel } from './matter-registry-state';
import type { MatterTimings } from './matter-registry-types';
import { buildStateUpdates } from './matter-state-updates';
import type { MatterStateUpdateQueue } from './matter-state-update-queue';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { resolvePersistedThermostatFallback } from './matter-thermostat-recovery-request';
import type { MatterTopologyCoordinator } from './matter-topology-coordinator';

const MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR = true;

/** What the registration path shares with the registry facade. */
export interface MatterRegistrationContext {
    api: API;
    log: Logger;
    getWsClient: () => KseniaWebSocketClient | undefined;
    momentaryAutoOffMs?: number;
    timings: MatterTimings;
    recoveryRequests: Record<string, number>;
    registrations: Map<string, MatterRegistration>;
    cachedUUIDs: Set<string>;
    cachedDevices: Map<string, KseniaDevice>;
    cachedLabels: Map<string, CachedEndpointLabel>;
    thermostatFallbackUUIDs: Set<string>;
    fallbackStore: MatterFallbackStore;
    thermostatEchoTracker: MatterThermostatEchoTracker;
    pruneTracker: MatterPruneTracker;
    nameService: MatterNameService;
    topologyCoordinator: MatterTopologyCoordinator;
    stateUpdateQueue: MatterStateUpdateQueue;
    reachability: MatterReachability;
    /** The facade's update path: a caller that joins an in-flight registration continues there. */
    updateAccessoryState: (device: KseniaDevice) => Promise<void>;
}

/**
 * The Matter registration path: shape of the endpoint, register, probe until
 * the endpoint answers, then `registered`; failures go to
 * `matter-registration-recovery.ts`. One registration in flight per device.
 *
 * Thermostat-specific steps sit in two places only: `resolveShape` (which
 * shape to register) and `onRegistered` (what a successful native register
 * clears).
 */
export class MatterRegistrationFlow {
    private readonly gate = new MatterRegistrationGate();
    private readonly settlement: RegisterSettlement;

    constructor(private readonly ctx: MatterRegistrationContext) {
        this.settlement = new RegisterSettlement(ctx.api);
    }

    public register(device: KseniaDevice, isRename = false): Promise<void> {
        return this.gate.run(
            device.id,
            () => this.performRegistration(device, isRename),
            () => this.ctx.updateAccessoryState(device),
        );
    }

    public upgradeToDimmable(device: KseniaDevice): Promise<void> {
        return this.gate.run(device.id, () => upgradeToDimmableLight(device, {
            log: this.ctx.log,
            topologyCoordinator: this.ctx.topologyCoordinator,
            registrations: this.ctx.registrations,
            register: (d) => this.performRegistration(d, true),
        }), () => this.ctx.updateAccessoryState(device));
    }

    public enqueueStateFor(device: KseniaDevice): void {
        const reg = this.ctx.registrations.get(device.id);
        if (!reg || !hasObservedState(device)) return;
        enqueueDeviceState(reg, device, device.type === 'thermostat' && this.ctx.thermostatFallbackUUIDs.has(device.id));
    }

    public refreshMetadata(device: KseniaDevice, reg: MatterRegistration): void {
        const fallback = device.type === 'thermostat' && this.ctx.thermostatFallbackUUIDs.has(device.id);
        const matterAccessory = this.mapShape(device, fallback);
        if (!matterAccessory) return;
        if (refreshRegistrationMetadata(reg, matterAccessory)) this.ctx.pruneTracker.recordMetadataChanged();
        else this.ctx.pruneTracker.recordMetadataUnchanged();
    }

    private mapShape(device: KseniaDevice, thermostatFallback: boolean): MatterAccessory | undefined {
        return thermostatFallback
            ? mapThermostatAsTemperatureSensor(device as KseniaThermostat, this.mapperDeps())
            : deviceToMatterAccessory(device, this.mapperDeps());
    }

    /** Which shape this device registers with: a persisted thermostat fallback stays a TemperatureSensor. */
    private async resolveShape(device: KseniaDevice): Promise<{ accessory?: MatterAccessory; fallback: boolean }> {
        const { ctx } = this;
        const fallback = await resolvePersistedThermostatFallback(
            device.id,
            device.type === 'thermostat' && ctx.thermostatFallbackUUIDs.has(device.id),
            {
                log: ctx.log,
                fallbackStore: ctx.fallbackStore,
                topologyCoordinator: ctx.topologyCoordinator,
                fallbackDeviceIds: ctx.thermostatFallbackUUIDs,
                recoveryRequests: ctx.recoveryRequests,
            },
        );
        return { accessory: this.mapShape(device, fallback), fallback };
    }

    private async performRegistration(discovered: KseniaDevice, isRename: boolean): Promise<void> {
        const { ctx } = this;
        const cached = ctx.cachedDevices.get(discovered.id);
        // Discovery placeholders must not overwrite the state Homebridge restored from its cache.
        const device = withCachedDimmable(hasObservedState(discovered) ? discovered : mergeKnownState(discovered, cached), cached);
        const { accessory: matterAccessory, fallback } = await this.resolveShape(device);
        if (!matterAccessory) return;

        const reg: MatterRegistration = {
            uuid: device.id,
            displayName: device.name,
            deviceType: device.type,
            matterAccessory,
            status: 'pending',
            recoveryAttempts: 0,
            pendingStateUpdates: hasObservedState(device) ? buildStateUpdates(device, fallback) : [],
        };
        ctx.registrations.set(device.id, reg);

        const fromCache = ctx.cachedUUIDs.has(device.id);
        if (!isRename) {
            if (fromCache) ctx.pruneTracker.recordCachedRestore();
            else ctx.pruneTracker.recordNewlyRegistered();
        }
        logRegisterRequested(ctx.log, device, matterAccessory.displayName, { fromCache, fallback, isRename });
        // We must always call registerPlatformAccessories — the MatterServer keeps
        // a runtime accessory map that is populated only on register. The Homebridge
        // accessory cache (configureMatterAccessory) is necessary but NOT sufficient:
        // without register, `updateAccessoryState` fails with
        // `Accessory <UUID> not found or not registered`. The same UUID is reused, so
        // Apple Home rooms and automations survive the re-register.
        try {
            // Record the thermostat-cluster values we're about to register with
            // matter.js as already-pushed, so the very first handler firings (which
            // some matter.js versions emit eagerly after registerPlatformAccessories)
            // are recognised as echoes of our own register payload, not external commands.
            if (device.type === 'thermostat' && !fallback) {
                const tc = matterAccessory.clusters?.thermostat as Record<string, unknown> | undefined;
                if (tc) ctx.thermostatEchoTracker.recordPushed(device.id, tc);
            }
            const existedBefore = !this.settlement.registerIsSettled && await this.settlement.exists(device.id);
            await ctx.topologyCoordinator.register(matterAccessory);
            if (!existedBefore) await this.settlement.observeNewEndpoint(device.id);
            // Only the first registration can attach to the cache-restored endpoint.
            reg.registeredDisplayName = liveNodeLabel(matterAccessory, ctx.cachedLabels.get(device.id));
            ctx.cachedLabels.delete(device.id);
        } catch (err) {
            await handleRegisterFailure(device, reg, err, this.recoveryDeps());
            return;
        }
        if (isRename) await this.completeRegistration(device.id);
        else void this.completeRegistration(device.id);
    }

    private async completeRegistration(uuid: string): Promise<void> {
        const { ctx } = this;
        const reg = ctx.registrations.get(uuid);
        if (!reg || reg.status !== 'pending') return;

        const { timings } = ctx;
        const queryable = await probeUntilQueryable(ctx.api, ctx.log, (e) => fmtErr(e), reg, {
            timeoutMs: this.settlement.registerIsSettled
                ? Math.min(timings.settledRegisterProbeTimeoutMs, timings.registerProbeTimeoutMs)
                : timings.registerProbeTimeoutMs,
            initialDelayMs: timings.registerProbePollMs,
            maxDelayMs: timings.registerProbePollMaxMs,
        });
        if (!queryable) {
            await handleMissingRegisteredAccessory(reg, this.recoveryDeps());
            return;
        }

        reg.status = 'registered';
        ctx.topologyCoordinator.markLocallyPublished(uuid);
        reg.registeredAt = Date.now();
        this.onRegistered(reg);
        ctx.stateUpdateQueue.markReadyAfterBootstrap(reg, timings.stateBootstrapMs);
        ctx.log.info(`[Matter] registered: ${reg.displayName}`);
        ctx.stateUpdateQueue.scheduleFlush(uuid);
        ctx.reachability.onRegistered(uuid);
        // A level reported while the registration was pending was only queued.
        const latest = reg.matterAccessory.context?.device as KseniaDevice | undefined;
        if (latest && needsDimmableUpgrade(reg, latest)) void ctx.updateAccessoryState(latest);
    }

    /** A thermostat that registered natively drops its stale fallback marker. */
    private onRegistered(reg: MatterRegistration): void {
        if (reg.deviceType !== 'thermostat' || isFallbackTemperatureSensor(reg)) return;
        this.ctx.thermostatFallbackUUIDs.delete(reg.uuid);
        this.ctx.fallbackStore.markNative(reg.uuid);
    }

    private republishKnownState(uuid: string): void {
        const device = this.ctx.registrations.get(uuid)?.matterAccessory.context?.device as KseniaDevice | undefined;
        if (!device) return;
        this.enqueueStateFor(device);
        this.ctx.stateUpdateQueue.scheduleFlush(uuid);
    }

    private mapperDeps() {
        const { ctx } = this;
        return {
            api: ctx.api,
            log: ctx.log,
            getWsClient: ctx.getWsClient,
            momentaryAutoOffMs: ctx.momentaryAutoOffMs,
            thermostatEchoTracker: ctx.thermostatEchoTracker,
            resolveDisplayName: (device: KseniaDevice) => ctx.nameService.resolveName(device),
            getLatestDevice: (id: string) => ctx.registrations.get(id)?.matterAccessory.context?.device as KseniaDevice | undefined,
            // Pushes the last observed state again, e.g. after the panel refused a Matter command.
            republishState: (id: string) => this.republishKnownState(id),
        };
    }

    private recoveryDeps(): Parameters<typeof handleMissingRegisteredAccessory>[1] {
        const { ctx } = this;
        return {
            api: ctx.api,
            topologyCoordinator: ctx.topologyCoordinator,
            log: ctx.log,
            thermostatFallbackUUIDs: ctx.thermostatFallbackUUIDs,
            getWsClient: ctx.getWsClient,
            scheduleComplete: (uuid) => { void this.completeRegistration(uuid); },
            fmtErr,
            thermostatFallbackEnabled: MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR,
            momentaryAutoOffMs: ctx.momentaryAutoOffMs,
            onFallbackPersist: (uuid) => ctx.fallbackStore.add(uuid),
            resolveDisplayName: (device: KseniaDevice) => ctx.nameService.resolveName(device),
            registerRetryMs: ctx.timings.registerRetryMs,
        };
    }
}

export function fmtErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
