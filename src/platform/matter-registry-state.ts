import type { API, Logger, MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import { hasAccessoryMetadataChanged } from './matter-device-mapper';
import type { MatterRegistration } from './matter-registration-recovery';
import { MatterStateUpdateQueue } from './matter-state-update-queue';
import { mergeStateUpdates } from './matter-state-updates';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';

/**
 * The queue records every thermostat-cluster push so the mapper's
 * attribute-change handlers can recognise their own state echo and skip
 * forwarding it back to Lares4. See matter-thermostat-echo-tracker.ts for the
 * loop failure mode this prevents.
 */
export function createStateUpdateQueue(
    api: API,
    log: Logger,
    registrations: Map<string, MatterRegistration>,
    tracker: MatterThermostatEchoTracker,
): MatterStateUpdateQueue {
    return new MatterStateUpdateQueue(
        api,
        log,
        registrations,
        (err) => (err instanceof Error ? err.message : String(err)),
        (uuid, clusterName, attrs) => {
            if (clusterName === 'thermostat') tracker.recordPushed(uuid, attrs);
        },
    );
}

/**
 * Records the latest snapshot on the registration (handlers read it from
 * there) and queues its state for the clusters the registered endpoint really
 * has. A light that turns out to dim still sits on an OnOffLight endpoint
 * until the upgrade re-registers it: a LevelControl write there makes
 * `endpoint.set` throw inside Homebridge, and nobody sees the failure.
 */
export function enqueueDeviceState(reg: MatterRegistration, device: KseniaDevice, thermostatAsFallback: boolean): void {
    reg.matterAccessory.context.device = device;
    const clusters = reg.matterAccessory.clusters ?? {};
    mergeStateUpdates(reg.pendingStateUpdates, device, thermostatAsFallback, (name) => name in clusters);
}

/**
 * A re-mapping only refreshes the accessory's identity fields. Clusters,
 * device type and handlers describe the live endpoint and change only through
 * a re-registration; taking them from a re-mapping made the registry believe
 * the endpoint had clusters it does not have (e.g. LevelControl on an
 * OnOffLight, which also disabled the dimmer upgrade).
 */
export function refreshRegistrationMetadata(reg: MatterRegistration, mapped: MatterAccessory): boolean {
    if (!hasAccessoryMetadataChanged(reg.matterAccessory, mapped)) return false;
    reg.matterAccessory = {
        ...reg.matterAccessory,
        displayName: mapped.displayName,
        manufacturer: mapped.manufacturer,
        model: mapped.model,
        serialNumber: mapped.serialNumber,
        firmwareRevision: mapped.firmwareRevision,
    };
    reg.displayName = mapped.displayName;
    return true;
}

/**
 * Includes the *post-sanitisation* displayName + length so register failures
 * can be diagnosed without re-deriving the sanitiser output: the original
 * `device.name` may exceed Matter's 32-char nodeLabel limit while the
 * displayName actually sent to matter.js does not.
 */
export function logRegisterRequested(
    log: Logger,
    device: KseniaDevice,
    matterName: string,
    flags: { fromCache: boolean; fallback: boolean; isRename: boolean },
): void {
    const nameAnnotation = matterName !== device.name
        ? ` -> "${matterName}" [${matterName.length}ch]`
        : ` [${matterName.length}ch]`;
    log.info(
        `[Matter] register requested: ${device.name}${nameAnnotation} `
        + `(${device.type}, uuid=${device.id})`
        + `${flags.fromCache ? ' [cache restore]' : ''}${flags.fallback ? ' [fallback]' : ''}${flags.isRename ? ' [rename]' : ''}`,
    );
}

export interface CachedEndpointLabel {
    displayName?: string;
    deviceTypeName?: string;
}

/**
 * The name a just-registered endpoint really shows. Homebridge 2.4 attaches a
 * same-shaped registration to the endpoint restored from its cache and keeps
 * that endpoint as it is, so its nodeLabel stays the cached displayName; only
 * a fresh endpoint takes the new one. The name finalizer diffs against this.
 */
export function liveNodeLabel(accessory: MatterAccessory, cached: CachedEndpointLabel | undefined): string {
    const attachedInPlace = !!cached?.displayName && cached.deviceTypeName === accessory.deviceType?.name;
    return attachedInPlace ? cached.displayName as string : accessory.displayName;
}
