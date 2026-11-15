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
 * UUID. This cannot happen in place: the device type is fixed when matter.js
 * builds the endpoint, and Homebridge refuses a register of a UUID it holds in
 * this session ("already registered", AccessoryManager.js:164-169; only an
 * endpoint restored from its cache is rebuilt, :157-162). So the old endpoint
 * must be observed gone first; the new one then gets the old `uniqueId` back.
 * It happens once per light: the cache remembers the capability.
 */
export async function upgradeToDimmableLight(
    device: KseniaDevice,
    deps: {
        log: Logger;
        topologyCoordinator: MatterTopologyCoordinator;
        registrations: Map<string, MatterRegistration>;
        /** Registers the DimmableLight; the new endpoint gets `inheritUniqueId` back once it answers. */
        register: (device: KseniaDevice, inheritUniqueId?: string) => Promise<void>;
    },
): Promise<void> {
    deps.log.info(`[Matter] ${device.name} reports a brightness level; re-registering as DimmableLight`);
    const uniqueId = await deps.topologyCoordinator.readUniqueId(device.id);
    const removed = await deps.topologyCoordinator.unregister(device.id, 'onOff');
    if (!removed) {
        const reg = deps.registrations.get(device.id);
        if (reg) failedUpgrades.add(reg);
        deps.log.warn(`[Matter] ${device.name} stays OnOffLight: the previous endpoint could not be removed`);
        return;
    }
    deps.registrations.delete(device.id);
    deps.topologyCoordinator.inheritOnNextRegister(device.id, uniqueId);
    await deps.register(device, uniqueId);
}
