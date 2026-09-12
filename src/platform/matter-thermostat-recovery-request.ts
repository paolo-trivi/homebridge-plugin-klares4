import type { Logger } from 'homebridge';
import type { MatterFallbackStore } from './matter-fallback-store';
import type { MatterTopologyCoordinator } from './matter-topology-coordinator';

interface RecoveryRequestDeps {
    log: Logger;
    fallbackStore: MatterFallbackStore;
    topologyCoordinator: MatterTopologyCoordinator;
    fallbackDeviceIds: Set<string>;
    recoveryRequests: Record<string, number>;
}

export async function resolvePersistedThermostatFallback(
    deviceId: string,
    persistedFallback: boolean,
    deps: RecoveryRequestDeps,
): Promise<boolean> {
    const request = deps.recoveryRequests[deviceId];
    if (!persistedFallback || typeof request !== 'number') return persistedFallback;
    if (!deps.fallbackStore.beginRecovery(deviceId, request)) return persistedFallback;

    const removed = await deps.topologyCoordinator.unregister(deviceId, 'temperatureMeasurement');
    if (!removed) {
        deps.fallbackStore.add(deviceId, 'recovery-unregister-timeout');
        return true;
    }

    deps.fallbackDeviceIds.delete(deviceId);
    deps.log.warn(`[Matter] explicit Thermostat recovery requested for ${deviceId}`);
    return false;
}
