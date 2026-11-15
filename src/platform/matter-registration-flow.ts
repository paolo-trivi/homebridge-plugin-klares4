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
import {
    needsThermostatReshape, pinRegisteredRole, reshapeThermostatEndpoint, startThermostatAttempts,
} from './matter-thermostat-attempts';
import { forgetSensorIdentity } from './matter-thermostat-recovery-request';
import { ThermostatRoleWait } from './matter-thermostat-role-wait';
import { thermostatShapeOf } from './matter-thermostat-shape';
import type { MatterTopologyCoordinator } from './matter-topology-coordinator';

const MATTER_THERMOSTAT_FALLBACK_TO_TEMPERATURE_SENSOR = true;

/**
 * Why a device is registered again in the same session: a rename the endpoint
 * did not take in place, or the dimmer upgrade. Both replace an endpoint
 * observed gone; `inheritUniqueId` is the identity the new one gets back.
 */
export interface ReregisterOptions {
    reason: 'rename' | 'upgrade';
    inheritUniqueId?: string;
}

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
 * Thermostat-specific steps: `resolveShape` (which shape to register),
 * `onRegistered` (what a successful native register clears and remembers) and
 * `reshapeThermostat` (a registered Thermostat whose output role changed).
 */
export class MatterRegistrationFlow {
    private readonly gate = new MatterRegistrationGate();
    private readonly settlement: RegisterSettlement;
    /** Thermostats whose payload attempts this registry has started. */
    private readonly thermostatAttemptsStarted = new Set<string>();
    private readonly roleWait: ThermostatRoleWait;

    constructor(private readonly ctx: MatterRegistrationContext) {
        this.settlement = new RegisterSettlement(ctx.api);
        this.roleWait = new ThermostatRoleWait(ctx.timings.thermostatRoleWaitMs, ctx.log, (device) => {
            void ctx.updateAccessoryState(device);
        });
    }

    public register(device: KseniaDevice, reregister?: ReregisterOptions): Promise<void> {
        // A thermostat whose role is still a guess from its name waits for the programs.
        if (!reregister && this.roleWait.hold(device)) return Promise.resolve();
        return this.gate.run(
            device.id,
            () => this.performRegistration(device, reregister),
            () => this.ctx.updateAccessoryState(device),
        );
    }

    public upgradeToDimmable(device: KseniaDevice): Promise<void> {
        return this.gate.run(device.id, () => upgradeToDimmableLight(device, {
            log: this.ctx.log,
            topologyCoordinator: this.ctx.topologyCoordinator,
            registrations: this.ctx.registrations,
            register: (d, inheritUniqueId) => this.performRegistration(d, { reason: 'upgrade', inheritUniqueId }),
        }), () => this.ctx.updateAccessoryState(device));
    }

    public enqueueStateFor(device: KseniaDevice): void {
        const reg = this.ctx.registrations.get(device.id);
        if (!reg) return;
        // The update below is built for the live endpoint's role, so it lands even before (or without) the reshape.
        if (device.type === 'thermostat' && reg.status === 'registered' && needsThermostatReshape(reg.matterAccessory, device)) {
            void this.reshapeThermostat(device);
        }
        if (!hasObservedState(device)) return;
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
        const accessory = thermostatFallback
            ? mapThermostatAsTemperatureSensor(device as KseniaThermostat, this.mapperDeps())
            : deviceToMatterAccessory(device, this.mapperDeps());
        // Controller commands and state pushes on the endpoint run one after the other.
        return accessory && this.ctx.stateUpdateQueue.commands.guard(accessory);
    }

    /** Which shape this device registers with: a persisted thermostat fallback stays a TemperatureSensor. */
    private async resolveShape(device: KseniaDevice): Promise<{ accessory?: MatterAccessory; fallback: boolean }> {
        const { ctx } = this;
        if (device.type === 'thermostat' && !this.thermostatAttemptsStarted.has(device.id)) {
            this.thermostatAttemptsStarted.add(device.id);
            startThermostatAttempts(device.id, ctx.fallbackStore.rememberedShape(device.id));
        }
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

    private async performRegistration(discovered: KseniaDevice, reregister?: ReregisterOptions): Promise<void> {
        const { ctx } = this;
        const cached = ctx.cachedDevices.get(discovered.id);
        // Discovery placeholders must not overwrite the state Homebridge restored from its cache.
        const device = withCachedDimmable(hasObservedState(discovered) ? discovered : mergeKnownState(discovered, cached), cached);
        const { accessory: matterAccessory, fallback } = await this.resolveShape(device);
        pinRegisteredRole(device, matterAccessory, ctx.thermostatEchoTracker);
        if (!matterAccessory) return;

        const reg: MatterRegistration = {
            uuid: device.id,
            displayName: device.name,
            deviceType: device.type,
            matterAccessory,
            status: 'pending',
            recoveryAttempts: 0,
            pendingStateUpdates: hasObservedState(device) ? buildStateUpdates(device, fallback) : [],
            inheritedUniqueId: reregister?.inheritUniqueId,
        };
        ctx.registrations.set(device.id, reg);

        const fromCache = ctx.cachedUUIDs.has(device.id);
        if (!reregister) {
            if (fromCache) ctx.pruneTracker.recordCachedRestore();
            else ctx.pruneTracker.recordNewlyRegistered();
        }
        logRegisterRequested(ctx.log, device, matterAccessory.displayName, { fromCache, fallback, reregister: reregister?.reason });
        // We must always call registerPlatformAccessories — the MatterServer keeps
        // a runtime accessory map that is populated only on register. The Homebridge
        // accessory cache (configureMatterAccessory) is necessary but NOT sufficient:
        // without register, `updateAccessoryState` fails with
        // `Accessory <UUID> not found or not registered`. The same UUID is reused, so
        // Apple Home rooms and automations survive the re-register.
        try {
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
        if (reregister) await this.completeRegistration(device.id);
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
        const inherited = reg.inheritedUniqueId;
        reg.inheritedUniqueId = undefined;
        if (inherited) await ctx.topologyCoordinator.restoreUniqueId(uuid, inherited);
        this.onRegistered(reg);
        ctx.stateUpdateQueue.markReadyAfterBootstrap(reg, timings.stateBootstrapMs);
        ctx.log.info(`[Matter] registered: ${reg.displayName}`);
        ctx.stateUpdateQueue.scheduleFlush(uuid);
        ctx.reachability.onRegistered(uuid);
        // A level reported while the registration was pending was only queued.
        const latest = reg.matterAccessory.context?.device as KseniaDevice | undefined;
        if (latest && (needsDimmableUpgrade(reg, latest) || needsThermostatReshape(reg.matterAccessory, latest))) {
            void ctx.updateAccessoryState(latest);
        }
    }

    /**
     * The output's role became known (program data read after the outputs) or
     * changed on the panel: the endpoint is replaced by one with the new
     * attribute set, keeping its identity. A caller arriving meanwhile joins.
     */
    private reshapeThermostat(device: KseniaThermostat): Promise<void> {
        return this.gate.run(device.id, async () => {
            const reg = this.ctx.registrations.get(device.id);
            if (!reg || reg.status !== 'registered' || !needsThermostatReshape(reg.matterAccessory, device)) return;
            if (!await reshapeThermostatEndpoint(reg, device, { log: this.ctx.log, topologyCoordinator: this.ctx.topologyCoordinator, fmtErr })) return;
            this.ctx.registrations.delete(device.id);
            await this.performRegistration(device, { reason: 'upgrade', inheritUniqueId: reg.inheritedUniqueId });
        }, () => this.ctx.updateAccessoryState(device));
    }

    /** A thermostat that registered natively drops its stale fallback marker. */
    private onRegistered(reg: MatterRegistration): void {
        if (reg.deviceType !== 'thermostat' || isFallbackTemperatureSensor(reg)) return;
        this.ctx.thermostatFallbackUUIDs.delete(reg.uuid);
        this.ctx.fallbackStore.markNative(reg.uuid, thermostatShapeOf(reg.uuid));
        // A Thermostat is another device than the sensor it replaces: new identity.
        forgetSensorIdentity(reg.uuid);
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
            // A push from a handler goes through the queue: it must not land inside a command.
            pushState: (id: string, cluster: string, attributes: Record<string, unknown>) => {
                const reg = ctx.registrations.get(id);
                if (reg) void ctx.stateUpdateQueue.pushOrQueue(reg, { clusterName: cluster, attributes });
            },
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
            thermostatEchoTracker: ctx.thermostatEchoTracker,
        };
    }
}

export function fmtErr(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
