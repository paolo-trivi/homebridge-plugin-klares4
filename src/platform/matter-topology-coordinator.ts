import type { API, Logger, MatterAccessory } from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import { toErrorMessage } from '../errors';

export type MatterPublicationState =
    | 'requested'
    | 'published-unverified'
    | 'locally-published'
    | 'failed';

/**
 * Every bridged endpoint carries this cluster whatever the plugin declared
 * (homebridge/dist/matter/server/AccessoryManager.js:810-832), so it tells an
 * absent endpoint from a cluster that only lacks readable attributes.
 */
const BRIDGED_INFO = 'bridgedDeviceBasicInformation';

/**
 * Budget for observing a topology or identity change (an unregistered
 * endpoint gone, a nodeLabel written). Raise it via config
 * (`matterUnregisterTimeoutMs`) or KLARES4_MATTER_UNREGISTER_TIMEOUT_MS on a
 * slow host.
 */
const DEFAULT_UNREGISTER_TIMEOUT_MS = 3_000;

/**
 * Grace period after the endpoint first reads as absent, followed by a second
 * probe. Homebridge 2.4 `unregisterAccessory` awaits `endpoint.close()` before
 * it deletes the UUID from its registry while `getAccessoryState` already
 * answers `undefined` for the closing endpoint: a register issued in that
 * window is rejected as "already registered" (only logged). Homebridge 2.5
 * resolves the unregister call only once the endpoint is gone
 * (MatterAPIImpl.js:348-352), but the two cannot be told apart from the
 * plugin, so the settle stays. Rename no longer goes through here (see
 * `renameInPlace`); only a device type change and the recovery paths do.
 */
const DEFAULT_UNREGISTER_SETTLE_MS = 1_000;

function resolveSettleMs(configured?: number): number {
    if (Number.isFinite(configured) && (configured as number) >= 0) return configured as number;
    const fromEnv = Number(process.env.KLARES4_MATTER_UNREGISTER_SETTLE_MS);
    return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_UNREGISTER_SETTLE_MS;
}

function resolveTimeout(configured?: number): number {
    if (Number.isFinite(configured) && (configured as number) > 0) return configured as number;
    const fromEnv = Number(process.env.KLARES4_MATTER_UNREGISTER_TIMEOUT_MS);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_UNREGISTER_TIMEOUT_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve): void => { setTimeout(resolve, ms); });

export class MatterTopologyCoordinator {
    private tail: Promise<void> = Promise.resolve();
    private readonly states = new Map<string, MatterPublicationState>();
    /**
     * Last accessory object handed to (or restored by) Homebridge per UUID.
     * Homebridge 2.4 `unregisterPlatformAccessories` reads
     * `accessory.deviceType.deviceType` before removing anything, so a bare
     * `{ UUID }` stub throws and the endpoint survives.
     */
    private readonly knownAccessories = new Map<string, MatterAccessory>();
    private readonly unregisterTimeoutMs: number;

    private readonly unregisterSettleMs: number;
    /** `uniqueId` the next endpoint registered under a UUID takes over (see `inheritOnNextRegister`). */
    private readonly pendingIdentities = new Map<string, string>();

    /**
     * `unregisterSettleMs`: the registry passes `MatterTimings.unregisterSettleMs`;
     * left out, KLARES4_MATTER_UNREGISTER_SETTLE_MS, then 1 s.
     */
    constructor(
        private readonly api: API,
        private readonly log: Logger,
        unregisterTimeoutMs?: number,
        unregisterSettleMs?: number,
    ) {
        this.unregisterTimeoutMs = resolveTimeout(unregisterTimeoutMs);
        this.unregisterSettleMs = resolveSettleMs(unregisterSettleMs);
    }

    /** Records an accessory restored from the Homebridge cache so it can be unregistered. */
    public remember(accessory: MatterAccessory): void {
        if (accessory?.UUID) this.knownAccessories.set(accessory.UUID, accessory);
    }

    public register(accessory: MatterAccessory): Promise<void> {
        return this.enqueue(accessory.UUID, async () => {
            this.states.set(accessory.UUID, 'requested');
            this.knownAccessories.set(accessory.UUID, accessory);
            await this.api.matter!.registerPlatformAccessories(
                PLUGIN_NAME,
                PLATFORM_NAME,
                [accessory],
            );
            this.states.set(accessory.UUID, 'published-unverified');
            const inherited = this.pendingIdentities.get(accessory.UUID);
            this.pendingIdentities.delete(accessory.UUID);
            // In the same queued operation as the register: nothing (probe,
            // `registered`, state updates) can see the endpoint before its
            // identity is the inherited one. A runtime whose register returns
            // before the endpoint exists (2.4) is covered by the observation
            // budget, and by the registration flow's own restore after the probe.
            if (inherited) await this.applyUniqueId(accessory.UUID, inherited, false);
        });
    }

    /**
     * The next endpoint registered under `uuid` replaces one that was observed
     * gone and is the same device: it takes over `uniqueId` as part of its
     * register. `undefined` cancels a pending one (the replacement is another
     * kind of device).
     */
    public inheritOnNextRegister(uuid: string, uniqueId: string | undefined): void {
        if (uniqueId) this.pendingIdentities.set(uuid, uniqueId);
        else this.pendingIdentities.delete(uuid);
    }

    public unregister(uuid: string, probeCluster: string): Promise<boolean> {
        return this.enqueue(uuid, async () => {
            this.states.set(uuid, 'requested');
            const known = this.knownAccessories.get(uuid);
            try {
                await this.api.matter!.unregisterPlatformAccessories(
                    PLUGIN_NAME,
                    PLATFORM_NAME,
                    [known ?? ({ UUID: uuid } as MatterAccessory)],
                );
            } catch (error: unknown) {
                // A rejection is no more proof that the endpoint survived than a
                // resolution is proof that it went away — only the probe below
                // decides. With the accessory object Homebridge registered, a
                // rejection is an anomaly worth seeing; with the bare stub it is
                // the expected TypeError (MatterAPIImpl.js:48-50, :335-342).
                const message = `[Matter] unregister call for ${uuid} threw, deferring to observation: ${toErrorMessage(error)}`;
                if (known) this.log.warn(message);
                else this.log.debug(message);
            }
            this.states.set(uuid, 'published-unverified');
            const absent = await this.waitUntilAbsent(uuid, probeCluster);
            this.states.set(uuid, absent ? 'locally-published' : 'failed');
            if (absent) this.knownAccessories.delete(uuid);
            return absent;
        });
    }

    /**
     * Renames a live endpoint without touching its topology: the endpoint, its
     * number and its `uniqueId` stay, so controllers keep rooms and
     * automations. Writes `nodeLabel` (a writable attribute of
     * BridgedDeviceBasicInformation; matter.js persists it, so it survives a
     * restart even before Homebridge saved its cache), then updates the
     * Homebridge cache record so `displayName` follows. Success is the new
     * label read back from the endpoint, never the resolution of the calls:
     * `updateAccessoryState` resolves even when Homebridge fails the update
     * (MatterAPIImpl.js:368-390, StateManager.js:103-142).
     */
    public renameInPlace(accessory: MatterAccessory, name: string): Promise<boolean> {
        const uuid = accessory.UUID;
        return this.enqueue(uuid, async () => {
            try {
                await this.api.matter!.updateAccessoryState(uuid, BRIDGED_INFO, { nodeLabel: name });
            } catch (error: unknown) {
                this.log.debug(`[Matter] nodeLabel update for ${uuid} threw, deferring to observation: ${toErrorMessage(error)}`);
            }
            const renamed = await this.observe(async () => (await this.readNodeLabel(uuid)) === name);
            if (renamed) await this.updateCachedRecord({ ...accessory, displayName: name });
            return renamed;
        });
    }

    /**
     * Updates the record Homebridge keeps for a live endpoint (displayName in
     * its Matter cache). Homebridge only logs when the record is not cached
     * yet (server.js:132-160); the next attach in place then writes it.
     */
    public async updateCachedRecord(accessory: MatterAccessory): Promise<void> {
        const known = this.knownAccessories.get(accessory.UUID);
        if (known) this.knownAccessories.set(accessory.UUID, { ...known, displayName: accessory.displayName });
        try {
            await this.api.matter!.updatePlatformAccessories([accessory]);
        } catch (error: unknown) {
            this.log.debug(`[Matter] cache update for ${accessory.UUID} failed: ${toErrorMessage(error)}`);
        }
    }

    /** The nodeLabel the live endpoint shows, or undefined when it cannot be read. */
    public async readNodeLabel(uuid: string): Promise<string | undefined> {
        const label = (await this.readBridgedInfo(uuid))?.nodeLabel;
        return typeof label === 'string' ? label : undefined;
    }

    /** The endpoint's BridgedDeviceBasicInformation.uniqueId, or undefined. */
    public async readUniqueId(uuid: string): Promise<string | undefined> {
        const uniqueId = (await this.readBridgedInfo(uuid))?.uniqueId;
        return typeof uniqueId === 'string' && uniqueId ? uniqueId : undefined;
    }

    /**
     * Gives an endpoint that had to be replaced (new device type, recovery) the
     * `uniqueId` of the endpoint it replaces. Homebridge does the same in its
     * own "changed structure" path (AccessoryManager.js:157-162) because a
     * controller may otherwise treat it as a new device, but only for
     * endpoints restored from its cache; a register of a live UUID gets a
     * random one (AccessoryManager.js:190, :827-829). matter.js accepts the
     * write and persists it across restarts. Observed, not assumed.
     */
    public restoreUniqueId(uuid: string, uniqueId: string): Promise<boolean> {
        return this.enqueue(uuid, () => this.applyUniqueId(uuid, uniqueId, true));
    }

    /** The endpoint about to be replaced has no readable `uniqueId`: the identity cannot be carried over. */
    public reportIdentityUnavailable(uuid: string): void {
        this.log.warn(
            `[Matter] ${uuid}: the endpoint being replaced shows no uniqueId (absent or not answering), so the new one `
            + 'gets a new identity; if controllers knew it, they may show it as a new device (rooms and automations to set again)',
        );
    }

    public markLocallyPublished(uuid: string): void {
        this.states.set(uuid, 'locally-published');
    }

    public markFailed(uuid: string): void {
        this.states.set(uuid, 'failed');
    }

    public getState(uuid: string): MatterPublicationState | undefined {
        return this.states.get(uuid);
    }

    private enqueue<T>(uuid: string, operation: () => Promise<T>): Promise<T> {
        const result = this.tail.catch((): void => undefined).then(operation);
        this.tail = result.then((): void => undefined, (error: unknown): void => {
            this.states.set(uuid, 'failed');
            this.log.warn(`[Matter] topology operation failed for ${uuid}: ${toErrorMessage(error)}`);
        });
        return result;
    }

    private async applyUniqueId(uuid: string, uniqueId: string, warnIfNotKept: boolean): Promise<boolean> {
        // On 2.4 register returns before the endpoint exists: a write now would
        // only be refused (and logged) by Homebridge. Wait for the endpoint.
        const current = await this.observeValue(() => this.readUniqueId(uuid));
        if (current === uniqueId) return true;
        if (current === undefined) {
            if (warnIfNotKept) this.log.warn(`[Matter] ${uuid}: could not keep the previous uniqueId; controllers may see a new device`);
            return false;
        }
        try {
            await this.api.matter!.updateAccessoryState(uuid, BRIDGED_INFO, { uniqueId });
        } catch (error: unknown) {
            this.log.debug(`[Matter] uniqueId update for ${uuid} threw, deferring to observation: ${toErrorMessage(error)}`);
        }
        const restored = await this.observe(async () => (await this.readUniqueId(uuid)) === uniqueId);
        if (!restored && warnIfNotKept) {
            this.log.warn(`[Matter] ${uuid}: could not keep the previous uniqueId; controllers may see a new device`);
        }
        return restored;
    }

    private async readBridgedInfo(uuid: string): Promise<Record<string, unknown> | undefined> {
        try {
            const state: unknown = await this.api.matter!.getAccessoryState(uuid, BRIDGED_INFO);
            return state && typeof state === 'object' ? state as Record<string, unknown> : undefined;
        } catch {
            return undefined;
        }
    }

    /** Polls `read` until it gives a value or the budget is spent. */
    private async observeValue<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
        let value: T | undefined;
        await this.observe(async () => (value = await read()) !== undefined);
        return value;
    }

    /** Polls `check` with a growing delay until it holds or the budget is spent. */
    private async observe(check: () => Promise<boolean>): Promise<boolean> {
        const deadline = Date.now() + this.unregisterTimeoutMs;
        let delay = 10;
        for (;;) {
            if (await check()) return true;
            if (Date.now() >= deadline) return false;
            await sleep(delay);
            delay = Math.min(250, delay * 2);
        }
    }

    /**
     * `getAccessoryState` answers `undefined` for a missing endpoint, but also
     * for a cluster without readable attributes or a read error
     * (StateManager.js:211-246): absence needs both the probe cluster and the
     * bridged information unreadable, twice, around the settle period.
     */
    private async isAbsent(uuid: string, clusterName: string): Promise<boolean> {
        try {
            if (await this.api.matter!.getAccessoryState(uuid, clusterName) !== undefined) return false;
            return await this.api.matter!.getAccessoryState(uuid, BRIDGED_INFO) === undefined;
        } catch {
            // An API error is not proof that the endpoint disappeared.
            return false;
        }
    }

    private async waitUntilAbsent(uuid: string, clusterName: string): Promise<boolean> {
        const deadline = Date.now() + this.unregisterTimeoutMs;
        let delay = 100;
        while (Date.now() < deadline) {
            if (await this.isAbsent(uuid, clusterName)) {
                await sleep(this.unregisterSettleMs);
                if (await this.isAbsent(uuid, clusterName)) return true;
            }
            await sleep(delay);
            delay = Math.min(1000, Math.round(delay * 1.5));
        }
        this.log.warn(`[Matter] unregister for ${uuid} was not locally observable before timeout`);
        return false;
    }
}

/**
 * The clusters the plugin declared for an accessory. Homebridge writes every
 * state update into the plugin's own `clusters` object, the bridged
 * information included (StateManager.js:116-127), so that key can appear
 * there without being declared. Without any declared cluster: the bridged
 * information, which every bridged endpoint has.
 */
export function declaredClusters(accessory: Pick<MatterAccessory, 'clusters'>): string[] {
    const names = Object.keys(accessory.clusters ?? {}).filter((name) => name !== BRIDGED_INFO);
    return names.length > 0 ? names : [BRIDGED_INFO];
}

export function registrationProbeCluster(accessory: Pick<MatterAccessory, 'clusters'>): string {
    return declaredClusters(accessory)[0] ?? BRIDGED_INFO;
}
