import type { API, Logger, MatterAccessory } from 'homebridge';
import type { KseniaDevice, KseniaThermostat } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import { mapThermostatAsTemperatureSensor } from './matter-device-mapper';
import { buildStateUpdates, type PendingMatterStateUpdate } from './matter-state-updates';
import { registrationProbeCluster, type MatterTopologyCoordinator } from './matter-topology-coordinator';

const MATTER_REGISTER_RECOVERY_LIMIT = 2;

export interface MatterRegistration {
    uuid: string;
    displayName: string;
    deviceType: string;
    matterAccessory: MatterAccessory;
    status: 'pending' | 'registered' | 'failed' | 'skipped';
    registeredAt?: number;
    stateUpdatesReadyAt?: number;
    failedAt?: number;
    lastError?: string;
    recoveryAttempts: number;
    pendingStateUpdates: PendingMatterStateUpdate[];
    /**
     * displayName last pushed to matter.js via `registerPlatformAccessories`.
     * This is the name the live endpoint (and the controllers) actually hold —
     * unlike `matterAccessory.displayName`, which in-memory re-mapping may
     * update without any push. The name-map finalize pass diffs against this.
     */
    registeredDisplayName?: string;
}

interface RecoveryDeps {
    api: API;
    topologyCoordinator: MatterTopologyCoordinator;
    log: Logger;
    thermostatFallbackUUIDs: Set<string>;
    getWsClient: () => KseniaWebSocketClient | undefined;
    scheduleComplete: (uuid: string) => void;
    fmtErr: (err: unknown) => string;
    thermostatFallbackEnabled: boolean;
    momentaryAutoOffMs?: number;
    onFallbackPersist?: (uuid: string) => void;
    resolveDisplayName?: (device: KseniaDevice) => string;
}

/** True when the registration currently maps to the TemperatureSensor fallback shape. */
export function isFallbackTemperatureSensor(reg: MatterRegistration): boolean {
    const clusters = reg.matterAccessory.clusters ?? {};
    return 'temperatureMeasurement' in clusters && !('thermostat' in clusters);
}

export async function isMatterAccessoryQueryable(
    api: API,
    log: Logger,
    fmtErr: (err: unknown) => string,
    reg: MatterRegistration,
): Promise<boolean> {
    const probeCluster = reg.pendingStateUpdates[0]?.clusterName
        ?? Object.keys(reg.matterAccessory.clusters ?? {})[0];
    if (!probeCluster) return true;

    try {
        const current = await api.matter!.getAccessoryState(reg.uuid, probeCluster);
        return current !== undefined;
    } catch (err) {
        log.debug(`[Matter] metadata probe failed for ${reg.displayName}: ${fmtErr(err)}`);
        return false;
    }
}

export async function handleMissingRegisteredAccessory(
    reg: MatterRegistration,
    deps: RecoveryDeps,
): Promise<void> {
    reg.recoveryAttempts += 1;

    const device = reg.matterAccessory.context.device as KseniaDevice | undefined;
    const shouldFallbackThermostat = reg.deviceType === 'thermostat'
        && !!device
        && !deps.thermostatFallbackUUIDs.has(reg.uuid)
        && deps.thermostatFallbackEnabled;

    if (shouldFallbackThermostat) {
        deps.log.warn(
            `[Matter] ${reg.displayName} was not queryable after registration; `
            + 'falling back to TemperatureSensor before sending state updates.',
        );
        try {
            await registerFallbackAccessory(device as KseniaThermostat, reg, deps);
            return;
        } catch (err) {
            deps.log.warn(`[Matter] Fallback TemperatureSensor failed for ${reg.displayName}: ${deps.fmtErr(err)}`);
        }
    }

    if (reg.recoveryAttempts <= MATTER_REGISTER_RECOVERY_LIMIT) {
        // Clear the endpoint for this UUID before re-registering. A stale matter.js
        // endpoint (observed in 2.1.3-rc.3 after the 32-char nodeLabel fix) keeps
        // the new accessory unqueryable, and Homebridge 2.4 rejects a second register
        // of a UUID it still holds. unregister+register reuses the same UUID, so
        // Apple Home rooms and automations survive.
        deps.log.warn(
            `[Matter] ${reg.displayName} was not queryable after registration; retrying registration `
            + `(${reg.recoveryAttempts}/${MATTER_REGISTER_RECOVERY_LIMIT}) [stale-endpoint purge].`,
        );
        try {
            await removeBeforeReregister(reg, deps);
            await deps.topologyCoordinator.register(reg.matterAccessory);
            reg.registeredDisplayName = reg.matterAccessory.displayName;
            deps.scheduleComplete(reg.uuid);
            return;
        } catch (err) {
            deps.log.warn(`[Matter] Registration retry failed for ${reg.displayName}: ${deps.fmtErr(err)}`);
        }
    }

    reg.status = 'failed';
    reg.failedAt = Date.now();
    reg.lastError = 'Matter accessory not queryable after registration';
    reg.pendingStateUpdates = [];
    deps.log.warn(`[Matter] accessory failed: ${reg.displayName} — ${reg.lastError}`);
}

/** A register call that threw: thermostats fall back to TemperatureSensor, everything else fails. */
export async function handleRegisterFailure(
    device: KseniaDevice,
    reg: MatterRegistration,
    err: unknown,
    deps: RecoveryDeps,
): Promise<void> {
    const msg = deps.fmtErr(err);
    if (device.type === 'thermostat' && deps.thermostatFallbackEnabled) {
        deps.log.warn(
            `Matter Thermostat registration failed for ${device.name}; falling back to TemperatureSensor. Error: ${msg}`,
        );
        try {
            await registerFallbackAccessory(device as KseniaThermostat, reg, deps);
            return;
        } catch (fbErr) {
            deps.log.warn(`[Matter] Fallback TemperatureSensor also failed for ${device.name}: ${deps.fmtErr(fbErr)}`);
        }
    }

    reg.status = 'failed';
    deps.topologyCoordinator.markFailed(device.id);
    reg.failedAt = Date.now();
    reg.lastError = msg;
    reg.pendingStateUpdates = [];
    deps.log.warn(`[Matter] accessory failed: ${device.name} — ${msg}`);
}

export async function registerFallbackAccessory(
    device: KseniaThermostat,
    reg: MatterRegistration,
    deps: Pick<RecoveryDeps, 'api' | 'log' | 'getWsClient' | 'thermostatFallbackUUIDs' | 'scheduleComplete' | 'momentaryAutoOffMs' | 'onFallbackPersist' | 'resolveDisplayName' | 'topologyCoordinator'>,
): Promise<void> {
    const fallback = mapThermostatAsTemperatureSensor(device, {
        api: deps.api,
        log: deps.log,
        getWsClient: deps.getWsClient,
        momentaryAutoOffMs: deps.momentaryAutoOffMs,
        resolveDisplayName: deps.resolveDisplayName,
    });
    await removeBeforeReregister(reg, deps);
    await deps.topologyCoordinator.register(fallback);
    deps.thermostatFallbackUUIDs.add(device.id);
    deps.onFallbackPersist?.(device.id);
    reg.matterAccessory = fallback;
    reg.registeredDisplayName = fallback.displayName;
    reg.status = 'pending';
    reg.recoveryAttempts = 0;
    reg.pendingStateUpdates = buildStateUpdates(device, true);
    deps.log.debug(`[Matter] fallback registered, probing: ${device.name}`);
    deps.scheduleComplete(device.id);
}

/**
 * Homebridge 2.4 rejects a register of a UUID it already holds, and only logs
 * the error, so a re-register must first observe the previous endpoint gone.
 * For a UUID Homebridge does not hold, the probe sees it absent at once.
 */
async function removeBeforeReregister(
    reg: MatterRegistration,
    deps: Pick<RecoveryDeps, 'topologyCoordinator'>,
): Promise<void> {
    const removed = await deps.topologyCoordinator.unregister(reg.uuid, registrationProbeCluster(reg.matterAccessory));
    if (!removed) throw new Error(`previous Matter endpoint for ${reg.uuid} is still present`);
}
