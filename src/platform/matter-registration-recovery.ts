import type { API, Logger } from 'homebridge';
import type { KseniaDevice, KseniaThermostat } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import { hasObservedState } from '../device-observation';
import { mapThermostatAsTemperatureSensor } from './matter-device-mapper';
import type { MatterRegistration } from './matter-registry-types';
import { buildStateUpdates } from './matter-state-updates';
import { declaredClusters, type MatterTopologyCoordinator } from './matter-topology-coordinator';
import { inheritIdentity, replaceEndpoint } from './matter-endpoint-replacement';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';
import { registerNextThermostatAttempt, resetThermostatAttempts } from './matter-thermostat-attempts';
import { takeSensorIdentity } from './matter-thermostat-recovery-request';

const MATTER_REGISTER_RECOVERY_LIMIT = 2;

export type { MatterRegistration };

/**
 * Homebridge 2.4 rejects a bridged register while the bridge's Matter server
 * is still starting and calls it transient. Nothing was registered, so the
 * next discovery or state update may simply try again.
 */
export function isTransientRegisterError(message: string): boolean {
    return /still starting/i.test(message);
}

export function canRetryRegistration(reg: MatterRegistration): boolean {
    return reg.status === 'failed' && reg.retryAfter !== undefined && Date.now() >= reg.retryAfter;
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
    /** Wait before a transient refusal may be retried (`MatterTimings.registerRetryMs`). */
    registerRetryMs: number;
    /** Records the payload of a second Thermostat attempt as pushed (echo guard). */
    thermostatEchoTracker?: MatterThermostatEchoTracker;
}

/** True when the registration currently maps to the TemperatureSensor fallback shape. */
export function isFallbackTemperatureSensor(reg: MatterRegistration): boolean {
    const clusters = reg.matterAccessory.clusters ?? {};
    return 'temperatureMeasurement' in clusters && !('thermostat' in clusters);
}

/**
 * The endpoint answers for every cluster the requested accessory declares. A
 * single cluster only proved that some endpoint holds the UUID: a stale one of
 * another shape could answer it too.
 */
export async function isMatterAccessoryQueryable(
    api: API,
    log: Logger,
    fmtErr: (err: unknown) => string,
    reg: MatterRegistration,
): Promise<boolean> {
    const clusters = declaredClusters(reg.matterAccessory);
    try {
        for (const cluster of clusters) {
            if (await api.matter!.getAccessoryState(reg.uuid, cluster) === undefined) return false;
        }
        return true;
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
        // A slow endpoint may have come up after the probe gave up (a short probe
        // budget on a runtime whose register does not wait): look once more
        // before calling the payload refused.
        if (reg.recoveryAttempts === 1 && await isMatterAccessoryQueryable(deps.api, deps.log, deps.fmtErr, reg)) {
            deps.scheduleComplete(reg.uuid);
            return;
        }
        // A runtime that refused the conformant payload may take the 2.2.0 one (TH-01).
        if (await registerNextThermostatAttempt(reg, deps)) return;
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
            await replaceEndpoint(reg, deps.topologyCoordinator, 'same-device');
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
    const transient = isTransientRegisterError(msg);
    // A transient refusal says nothing about the Thermostat shape: no fallback.
    if (device.type === 'thermostat' && deps.thermostatFallbackEnabled && !transient) {
        if (await registerNextThermostatAttempt(reg, deps)) return;
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
    if (transient) {
        reg.retryAfter = reg.failedAt + deps.registerRetryMs;
        deps.log.warn(`[Matter] register deferred: ${device.name} — the Matter server is still starting; retrying on a later update`);
        return;
    }
    deps.log.warn(`[Matter] accessory failed: ${device.name} — ${msg}`);
}

export async function registerFallbackAccessory(
    device: KseniaThermostat,
    reg: MatterRegistration,
    deps: Pick<RecoveryDeps, 'api' | 'log' | 'getWsClient' | 'thermostatFallbackUUIDs' | 'scheduleComplete' | 'momentaryAutoOffMs' | 'onFallbackPersist' | 'resolveDisplayName' | 'topologyCoordinator'>,
): Promise<void> {
    resetThermostatAttempts(device.id);
    const fallback = mapThermostatAsTemperatureSensor(device, {
        api: deps.api,
        log: deps.log,
        getWsClient: deps.getWsClient,
        momentaryAutoOffMs: deps.momentaryAutoOffMs,
        resolveDisplayName: deps.resolveDisplayName,
    });
    await replaceEndpoint(reg, deps.topologyCoordinator, 'other-device');
    // Back to the sensor a recovery removed: the same device again, with its identity.
    inheritIdentity(reg, deps.topologyCoordinator, takeSensorIdentity(device.id));
    await deps.topologyCoordinator.register(fallback);
    deps.thermostatFallbackUUIDs.add(device.id);
    deps.onFallbackPersist?.(device.id);
    reg.matterAccessory = fallback;
    reg.registeredDisplayName = fallback.displayName;
    reg.status = 'pending';
    reg.recoveryAttempts = 0;
    reg.pendingStateUpdates = hasObservedState(device) ? buildStateUpdates(device, true) : [];
    deps.log.debug(`[Matter] fallback registered, probing: ${device.name}`);
    deps.scheduleComplete(device.id);
}
