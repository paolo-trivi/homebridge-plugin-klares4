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

/**
 * Decides, at registration, whether a thermostat with a persisted fallback
 * stays a TemperatureSensor (`true`) or tries the native Thermostat again
 * (`false`). Two ways back:
 * - an explicit `matterRecoveryRequests` generation not processed yet;
 * - once, automatically, a fallback persisted before the current Thermostat
 *   payload existed (2.2.0 and earlier sent a payload matter.js 0.18 refuses,
 *   so those fallbacks say nothing about the device).
 * A failed attempt ends in the usual fallback path, which persists the
 * fallback again with the current payload revision: no further automatic try.
 */
/**
 * `uniqueId` of the TemperatureSensor fallback a recovery removed, until the
 * recovery ends. If the Thermostat is refused again the sensor comes back with
 * it (same device, same function: rooms and automations stay); if the
 * Thermostat registers it is forgotten (another function: new identity).
 */
const sensorIdentities = new Map<string, string>();

/** The identity the sensor fallback of `uuid` gets back, once. */
export function takeSensorIdentity(uuid: string): string | undefined {
    const id = sensorIdentities.get(uuid);
    sensorIdentities.delete(uuid);
    return id;
}

export function forgetSensorIdentity(uuid: string): void {
    sensorIdentities.delete(uuid);
}

export async function resolvePersistedThermostatFallback(
    deviceId: string,
    persistedFallback: boolean,
    deps: RecoveryRequestDeps,
): Promise<boolean> {
    if (!persistedFallback) return false;
    const request = deps.recoveryRequests[deviceId];
    const explicit = typeof request === 'number' && deps.fallbackStore.beginRecovery(deviceId, request);
    const automatic = !explicit && deps.fallbackStore.beginAutomaticRecovery(deviceId);
    if (!explicit && !automatic) return true;

    const sensorId = await deps.topologyCoordinator.readUniqueId(deviceId);
    const removed = await deps.topologyCoordinator.unregister(deviceId, 'temperatureMeasurement');
    if (!removed) {
        deps.fallbackStore.add(deviceId, 'recovery-unregister-timeout');
        return true;
    }

    if (sensorId) sensorIdentities.set(deviceId, sensorId);
    deps.fallbackDeviceIds.delete(deviceId);
    deps.log.warn(explicit
        ? `[Matter] explicit Thermostat recovery requested for ${deviceId}`
        : `[Matter] ${deviceId} was saved as a TemperatureSensor fallback by an earlier version; `
            + 'trying the native Thermostat once (it goes back to TemperatureSensor if Homebridge does not accept it).');
    return false;
}
