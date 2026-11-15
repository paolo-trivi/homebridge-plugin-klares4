import type { API, MatterAccessory } from 'homebridge';

/** Longest wait for the plugin's state pushes to be applied, or for Homebridge to finish a command. */
const APPLY_LIMIT_MS = 1000;
const POLL_MS = 2;
/**
 * How long after a push was requested a command keeps waiting even once the
 * endpoint reads the pushed values: matter.js shows a committed value while
 * the push's transaction still runs its reactors and holds the lock (seen up
 * to ~120 ms on a loaded host). Homebridge 2.5 does not let a plugin await the
 * push itself (`MatterAPIImpl.updateAccessoryState` only emits), so this is
 * the remaining, timed part of the wait.
 */
const PUSH_QUIET_MS = 150;

/** The plugin's pushes to one cluster of one endpoint that Homebridge has not applied yet. */
interface ClusterPushes {
    cluster: string;
    /** What the endpoint holds once every outstanding push is applied. */
    expected: Record<string, unknown>;
    read: () => unknown;
    /** The cluster state object last seen. */
    seen: unknown;
    outstanding: number;
    since: number;
    polling: boolean;
}

/**
 * Serializes, per endpoint, the plugin's state pushes with the controller
 * commands Homebridge runs on it.
 *
 * Homebridge runs a command inside a matter.js transaction
 * (`server/StateManager.js` `triggerCommand`: `endpoint.act(...)`): the
 * plugin's handler, then matter.js's own implementation (`await super.on()`,
 * `super.moveToLevel()`, `super.goToLiftPercentage()`,
 * `super.setpointRaiseLower()`; `behaviors/OnOffBehavior.js:42-46`,
 * `LevelControlBehavior.js:25-27`, `WindowCoveringBehavior.js:141-143`,
 * `ThermostatBehavior.js:161-168`), then `syncStateToCache`. matter.js's step
 * changes the endpoint state and needs its lock synchronously. A state push
 * is applied in a transaction of its own (`StateManager.updateAccessoryState`:
 * `setImmediate`, then `endpoint.set`, then the cluster state object it
 * shares with the plugin is replaced); if that transaction is open when the
 * handler returns, the command fails towards the controller ("Cannot lock …
 * synchronously") although the panel already did what was asked.
 *
 * So: a push requested while a command runs on the endpoint waits in the
 * update queue until the command is over (`isBusy`, read by the queue); and a
 * command does not return before the pushes requested earlier have been
 * applied. Applied is observed, not timed: Homebridge replaces the shared
 * cluster state object once per applied push, in request order, so each
 * replacement seen accounts for one outstanding push. Replacements are
 * polled; two between polls count as one, which only makes the wait longer
 * (bounded by `APPLY_LIMIT_MS`, also the bound for a push Homebridge refuses,
 * which replaces nothing). A replacement alone is not proof: Homebridge also
 * refreshes that object from reactors inside the push's own transaction
 * (`OnOffBehavior.syncOnOffToCache`), so the endpoint must also read the
 * pushed values, which it does only once the transaction has committed.
 */
export class MatterCommandGuard {
    private readonly running = new Map<string, number>();
    private readonly clusters = new Map<string, ClusterPushes>();

    constructor(private readonly api: API) {}

    /** True while a command runs on `uuid`: its state pushes wait. */
    public isBusy(uuid: string): boolean {
        return (this.running.get(uuid) ?? 0) > 0;
    }

    /** A push for `uuid`/`cluster` is being requested; `read` returns the cluster state object Homebridge holds. */
    public notePush(uuid: string, cluster: string, attributes: Record<string, unknown>, read: () => unknown): void {
        const key = `${uuid}\u0000${cluster}`;
        const entry = this.clusters.get(key) ?? { cluster, expected: {}, read, seen: read(), outstanding: 0, since: 0, polling: false };
        if (entry.outstanding === 0) {
            entry.seen = read();
            entry.expected = {};
        }
        entry.expected = { ...entry.expected, ...attributes };
        entry.read = read;
        entry.outstanding += 1;
        entry.since = Date.now();
        this.clusters.set(key, entry);
        if (!entry.polling) this.poll(key, entry);
    }

    /** Wraps every handler of `accessory` so it runs as a command on its endpoint. */
    public guard(accessory: MatterAccessory): MatterAccessory {
        const handlers = accessory.handlers;
        if (!handlers) return accessory;
        const uuid = accessory.UUID;
        const wrapped: NonNullable<MatterAccessory['handlers']> = {};
        for (const [cluster, commands] of Object.entries(handlers)) {
            wrapped[cluster] = {};
            for (const [name, handler] of Object.entries(commands)) {
                // `…Change` handlers are attribute reactors (e.g. `systemModeChange`,
                // `occupiedHeatingSetpointChange`): they run inside the write's own
                // transaction, often the plugin's own push, with no matter.js step
                // after them, so they must not wait for pushes to be applied.
                const command = !name.endsWith('Change');
                const read = (): unknown => accessory.clusters?.[cluster];
                wrapped[cluster][name] = async (args: unknown, context?: unknown) => {
                    this.running.set(uuid, (this.running.get(uuid) ?? 0) + 1);
                    let finishedHandler = false;
                    try {
                        await handler(args, context as Parameters<typeof handler>[1]);
                        if (command) await this.pushesApplied(uuid);
                        finishedHandler = true;
                    } finally {
                        this.end(uuid, command && finishedHandler ? read : undefined);
                    }
                };
            }
        }
        return { ...accessory, handlers: wrapped };
    }

    private poll(key: string, entry: ClusterPushes): void {
        entry.polling = true;
        const current = entry.read();
        if (current !== entry.seen) {
            entry.seen = current;
            entry.outstanding = Math.max(0, entry.outstanding - 1);
        }
        if (entry.outstanding > 0 && Date.now() - entry.since >= APPLY_LIMIT_MS) entry.outstanding = 0;
        if (entry.outstanding === 0) {
            entry.polling = false;
            return;
        }
        setTimeout(() => this.poll(key, entry), POLL_MS);
    }

    private async pushesApplied(uuid: string): Promise<void> {
        const prefix = `${uuid}\u0000`;
        const started = Date.now();
        for (;;) {
            const tracked = [...this.clusters].filter(([key]) => key.startsWith(prefix)).map(([, entry]) => entry);
            let open = tracked.some((entry) => entry.outstanding > 0 || Date.now() - entry.since < PUSH_QUIET_MS);
            if (!open) {
                for (const entry of tracked) {
                    if (Object.keys(entry.expected).length === 0) continue;
                    if (await this.reads(uuid, entry.cluster, entry.expected)) entry.expected = {};
                    else open = true;
                }
            }
            if (!open || Date.now() - started >= APPLY_LIMIT_MS) return;
            await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
        }
    }

    /** True when the endpoint reads `expected` (partial objects, e.g. bitmaps, compared on their own keys). */
    private async reads(uuid: string, cluster: string, expected: Record<string, unknown>): Promise<boolean> {
        try {
            const state = await this.api.matter?.getAccessoryState(uuid, cluster);
            return state !== undefined && contains(state, expected);
        } catch {
            return false;
        }
    }

    /**
     * Ends the command once Homebridge has run its own step after the handler:
     * for a command that step ends with `syncStateToCache`, which replaces the
     * cluster's state object (`read`); no push of the plugin can replace it
     * meanwhile (none is outstanding, new ones wait). Otherwise (attribute
     * reactor, failed handler) one macrotask later; in any case within the limit.
     */
    private end(uuid: string, read?: () => unknown): void {
        const release = (): void => {
            const left = (this.running.get(uuid) ?? 1) - 1;
            if (left > 0) this.running.set(uuid, left);
            else this.running.delete(uuid);
        };
        if (!read) {
            setImmediate(release);
            return;
        }
        const before = read();
        const started = Date.now();
        const wait = (): void => {
            if (read() !== before || Date.now() - started >= APPLY_LIMIT_MS) release();
            else setTimeout(wait, POLL_MS);
        };
        setImmediate(wait);
    }
}

function contains(actual: unknown, expected: unknown): boolean {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
        if (actual === null || typeof actual !== 'object') return false;
        return Object.entries(expected).every(([key, value]) => contains((actual as Record<string, unknown>)[key], value));
    }
    return JSON.stringify(actual) === JSON.stringify(expected);
}
