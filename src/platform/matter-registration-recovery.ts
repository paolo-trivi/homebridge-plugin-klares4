import type { API, Logger, MatterAccessory } from 'homebridge';
import type { KseniaDevice, KseniaThermostat } from '../types';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { KseniaWebSocketClient } from '../websocket-client';
import { mapThermostatAsTemperatureSensor } from './matter-device-mapper';
import { buildStateUpdates, type PendingMatterStateUpdate } from './matter-state-updates';

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
        // On the *second* attempt, force-clear any stale matter.js endpoint for
        // this UUID before re-registering. Observed in production after the 32-char
        // nodeLabel fix (2.1.3-rc.3): scenario_12 had a previous endpoint stored in
        // matter.js with the old (over-limit) displayName, so `getAccessoryState`
        // kept returning undefined for the new accessory even though register
        // succeeded. unregister+register reuses the same UUID — Apple Home rooms
        // and automations survive — but forces matter.js to recreate the endpoint
        // record with the current sanitised displayName.
        const stalePurge = reg.recoveryAttempts >= 2;
        deps.log.warn(
            `[Matter] ${reg.displayName} was not queryable after registration; retrying registration `
            + `(${reg.recoveryAttempts}/${MATTER_REGISTER_RECOVERY_LIMIT})${stalePurge ? ' [stale-endpoint purge]' : ''}.`,
        );
        try {
            if (stalePurge) {
                try {
                    await deps.api.matter!.unregisterPlatformAccessories(
                        PLUGIN_NAME, PLATFORM_NAME, [{ UUID: reg.uuid } as MatterAccessory],
                    );
                } catch (unregErr) {
                    // Unregister may legitimately fail if matter.js doesn't have an
                    // endpoint for this UUID at all — that's exactly the state we
                    // want, so we ignore and proceed to register.
                    deps.log.debug(`[Matter] stale-endpoint unregister for ${reg.displayName} (${reg.uuid}) returned: ${deps.fmtErr(unregErr)}`);
                }
            }
            await deps.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [reg.matterAccessory]);
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

export async function registerFallbackAccessory(
    device: KseniaThermostat,
    reg: MatterRegistration,
    deps: Pick<RecoveryDeps, 'api' | 'log' | 'getWsClient' | 'thermostatFallbackUUIDs' | 'scheduleComplete' | 'momentaryAutoOffMs' | 'onFallbackPersist' | 'resolveDisplayName'>,
): Promise<void> {
    const fallback = mapThermostatAsTemperatureSensor(device, {
        api: deps.api,
        log: deps.log,
        getWsClient: deps.getWsClient,
        momentaryAutoOffMs: deps.momentaryAutoOffMs,
        resolveDisplayName: deps.resolveDisplayName,
    });
    await deps.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [fallback]);
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
