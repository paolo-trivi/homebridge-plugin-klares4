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
    failedAt?: number;
    lastError?: string;
    recoveryAttempts: number;
    pendingStateUpdates: PendingMatterStateUpdate[];
}

interface RecoveryDeps {
    api: API;
    log: Logger;
    thermostatFallbackUUIDs: Set<string>;
    getWsClient: () => KseniaWebSocketClient | undefined;
    scheduleComplete: (uuid: string) => void;
    fmtErr: (err: unknown) => string;
    settleMs: number;
    thermostatFallbackEnabled: boolean;
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
        deps.log.warn(
            `[Matter] ${reg.displayName} was not queryable after registration; retrying registration `
            + `(${reg.recoveryAttempts}/${MATTER_REGISTER_RECOVERY_LIMIT}).`,
        );
        try {
            await deps.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [reg.matterAccessory]);
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
    deps: Pick<RecoveryDeps, 'api' | 'log' | 'getWsClient' | 'thermostatFallbackUUIDs' | 'scheduleComplete' | 'settleMs'>,
): Promise<void> {
    const fallback = mapThermostatAsTemperatureSensor(device, {
        api: deps.api,
        log: deps.log,
        getWsClient: deps.getWsClient,
    });
    await deps.api.matter!.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [fallback]);
    deps.thermostatFallbackUUIDs.add(device.id);
    reg.matterAccessory = fallback;
    reg.status = 'pending';
    reg.recoveryAttempts = 0;
    reg.pendingStateUpdates = buildStateUpdates(device, true);
    deps.log.debug(`[Matter] settle started (${deps.settleMs}ms): ${device.name} [fallback]`);
    deps.scheduleComplete(device.id);
}
