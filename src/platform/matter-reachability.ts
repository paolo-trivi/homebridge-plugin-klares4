import type { API, Logger } from 'homebridge';
import type { MatterRegistration } from './matter-registration-recovery';

/**
 * Grace period before a lost panel connection is published. The WebSocket
 * client reconnects on its own, and a short blip must not flip every endpoint
 * (100+ on a real install) to unreachable and back.
 */
const DEFAULT_UNREACHABLE_GRACE_MS = 15_000;

function graceMs(): number {
    const fromEnv = Number(process.env.KLARES4_MATTER_UNREACHABLE_GRACE_MS);
    return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_UNREACHABLE_GRACE_MS;
}

/**
 * Mirrors the panel connection on BridgedDeviceBasicInformation.reachable of
 * every registered endpoint. Homebridge creates each endpoint with
 * `reachable: true` and nothing else ever changed it, so controllers kept
 * showing stale states as live while the panel was gone.
 *
 * Idempotent: only a change of the published value pushes, once per endpoint.
 */
export class MatterReachability {
    private published = true;
    private pendingUnreachable?: NodeJS.Timeout;

    constructor(
        private readonly api: API,
        private readonly log: Logger,
        private readonly registrations: Map<string, MatterRegistration>,
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
        }, graceMs());
        this.pendingUnreachable.unref?.();
    }

    /** An endpoint that completes its registration while the panel is gone starts reachable too. */
    public onRegistered(uuid: string): void {
        if (!this.published) this.push(uuid, false);
    }

    private publish(reachable: boolean): void {
        if (this.published === reachable) return;
        this.published = reachable;
        const uuids = [...this.registrations.values()].filter((reg) => reg.status === 'registered').map((reg) => reg.uuid);
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
