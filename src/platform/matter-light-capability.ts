import type { Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterTopologyCoordinator } from './matter-topology-coordinator';

/**
 * A Lares4 output only reveals that it dims when STATUS_OUTPUTS carries a
 * level (POS), which always arrives after the READ_RES discovery that triggers
 * the Matter registration. The mapper therefore saw `dimmable: false` and
 * registered every dimmer as OnOffLight, with no LevelControl cluster.
 */

/** Registrations whose upgrade already failed once: not retried for the session. */
const failedUpgrades = new WeakSet<MatterRegistration>();

/** Reuses the dimmer capability the Homebridge Matter cache remembers for this light. */
export function withCachedDimmable(device: KseniaDevice, cached: KseniaDevice | undefined): KseniaDevice {
    if (device.type !== 'light' || device.status?.dimmable) return device;
    if (cached?.type !== 'light' || !cached.status?.dimmable) return device;
    return { ...device, status: { ...device.status, dimmable: true } };
}

/** True when a registered on/off endpoint now belongs to a light that reports a level. */
export function needsDimmableUpgrade(reg: MatterRegistration, device: KseniaDevice): boolean {
    return device.type === 'light'
        && device.status?.dimmable === true
        && reg.status === 'registered'
        && !failedUpgrades.has(reg)
        && !('levelControl' in (reg.matterAccessory.clusters ?? {}));
}

/**
 * Replaces the OnOffLight endpoint with a DimmableLight one under the same
 * UUID. Homebridge rejects a register of a UUID it still holds, so the old
 * endpoint must be observed gone first.
 */
export async function upgradeToDimmableLight(
    device: KseniaDevice,
    deps: {
        log: Logger;
        topologyCoordinator: MatterTopologyCoordinator;
        registrations: Map<string, MatterRegistration>;
        register: (device: KseniaDevice) => Promise<void>;
    },
): Promise<void> {
    deps.log.info(`[Matter] ${device.name} reports a brightness level; re-registering as DimmableLight`);
    const removed = await deps.topologyCoordinator.unregister(device.id, 'onOff');
    if (!removed) {
        const reg = deps.registrations.get(device.id);
        if (reg) failedUpgrades.add(reg);
        deps.log.warn(`[Matter] ${device.name} stays OnOffLight: the previous endpoint could not be removed`);
        return;
    }
    deps.registrations.delete(device.id);
    await deps.register(device);
}
