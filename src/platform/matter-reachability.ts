import type { API, Logger } from 'homebridge';

/**
 * Mirrors the panel connection on BridgedDeviceBasicInformation.reachable of
 * every endpoint of the plugin: the ones registered in this session and the
 * ones Homebridge restored from its cache (each restore sets
 * `reachable: true`, so a panel offline since the boot would otherwise show
 * stale states as live).
 *
 * A lost connection is published after `graceMs`: the WebSocket client
 * reconnects on its own, and a short blip must not flip every endpoint (100+
 * on a real install) to unreachable and back.
 *
 * Idempotent: only a change of the published value pushes, once per endpoint.
 */
export class MatterReachability {
    private published = true;
    private pendingUnreachable?: NodeJS.Timeout;

    constructor(
        private readonly api: API,
        private readonly log: Logger,
        /** Every endpoint the plugin holds on the bridge (cached ∪ registered). */
        private readonly endpoints: () => Iterable<string>,
        private readonly graceMs: number,
    ) {}

    public set(reachable: boolean): void {
        if (reachable) {
            if (this.pendingUnreachable) clearTimeout(this.pendingUnreachable);
            this.pendingUnreachable = undefined;
            this.publish(true);
            return;
        }
        if (!this.published || this.pendingUnreachable) return;
        this.pendingUnreachable = setTimeout(() => {
            this.pendingUnreachable = undefined;
            this.publish(false);
        }, this.graceMs);
        this.pendingUnreachable.unref?.();
    }

    /** An endpoint (re)registered while the panel is gone must say so too. */
    public onRegistered(uuid: string): void {
        if (!this.published) this.push(uuid, false);
    }

    private publish(reachable: boolean): void {
        if (this.published === reachable) return;
        this.published = reachable;
        const uuids = [...new Set(this.endpoints())];
        this.log.info(`[Matter] panel ${reachable ? 'reachable again' : 'unreachable'}: updating ${uuids.length} endpoints`);
        for (const uuid of uuids) this.push(uuid, reachable);
    }

    private push(uuid: string, reachable: boolean): void {
        this.api.matter?.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', { reachable })
            .catch((err: unknown) => {
                this.log.debug(`[Matter] reachable=${reachable} update failed for ${uuid}: ${err instanceof Error ? err.message : String(err)}`);
            });
    }
}
