import type { API, Logger } from 'homebridge';
import type { MatterRegistration } from './matter-registration-recovery';
import type { PendingMatterStateUpdate } from './matter-state-updates';

// With the probe-based settle in MatterAccessoryRegistry (Fix 2), the endpoint
// is only marked `registered` once `getAccessoryState` actually returns. No
// additional bootstrap delay is needed; the env var stays available as an
// emergency override.
const DEFAULT_MATTER_STATE_UPDATE_BOOTSTRAP_MS = 0;
const MATTER_STATE_UPDATE_BOOTSTRAP_MS = Number(
    process.env.KLARES4_MATTER_STATE_BOOTSTRAP_MS ?? DEFAULT_MATTER_STATE_UPDATE_BOOTSTRAP_MS,
);

export class MatterStateUpdateQueue {
    private readonly flushTimers = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly api: API,
        private readonly log: Logger,
        private readonly registrations: Map<string, MatterRegistration>,
        private readonly fmtErr: (err: unknown) => string,
        /**
         * Invoked just before `api.matter.updateAccessoryState` so the registry can
         * record the values it's about to push (used by the thermostat echo tracker
         * to recognise its own state echo when matter.js re-fires the handlers).
         */
        private readonly onBeforePush?: (uuid: string, clusterName: string, attrs: Record<string, unknown>) => void,
    ) {}

    public markReadyAfterBootstrap(reg: MatterRegistration): void {
        reg.stateUpdatesReadyAt = Date.now() + MATTER_STATE_UPDATE_BOOTSTRAP_MS;
    }

    public async pushOrQueue(
        reg: MatterRegistration,
        update: PendingMatterStateUpdate,
    ): Promise<void> {
        if (!this.isReadyForStateUpdates(reg)) {
            this.queue(reg, update);
            this.scheduleFlush(reg.uuid);
            return;
        }

        await this.updateAccessoryState(reg, update);
    }

    public scheduleFlush(uuid: string): void {
        const reg = this.registrations.get(uuid);
        if (!reg || reg.pendingStateUpdates.length === 0) return;
        if (this.flushTimers.has(uuid)) return;

        const delay = Math.max(0, (reg.stateUpdatesReadyAt ?? Date.now()) - Date.now());
        const timer = setTimeout(() => {
            this.flushTimers.delete(uuid);
            void this.flush(uuid);
        }, delay);
        this.flushTimers.set(uuid, timer);
    }

    private async flush(uuid: string): Promise<void> {
        const reg = this.registrations.get(uuid);
        if (!reg || reg.status !== 'registered' || reg.pendingStateUpdates.length === 0) return;
        if (!this.isReadyForStateUpdates(reg)) {
            this.scheduleFlush(uuid);
            return;
        }

        const pending = reg.pendingStateUpdates.splice(0);
        this.log.debug(`[Matter] pending updates flush: ${reg.displayName} (${pending.length})`);
        for (const update of pending) {
            await this.updateAccessoryState(reg, update);
        }
    }

    private isReadyForStateUpdates(reg: MatterRegistration): boolean {
        return !reg.stateUpdatesReadyAt || Date.now() >= reg.stateUpdatesReadyAt;
    }

    private async updateAccessoryState(reg: MatterRegistration, update: PendingMatterStateUpdate): Promise<void> {
        try {
            this.onBeforePush?.(reg.uuid, update.clusterName, update.attributes);
            await this.api.matter!.updateAccessoryState(reg.uuid, update.clusterName, update.attributes, update.partId);
        } catch (err) {
            this.log.debug(`[Matter] state update failed for ${reg.displayName} (${update.clusterName}): ${this.fmtErr(err)}`);
        }
    }

    private queue(reg: MatterRegistration, update: PendingMatterStateUpdate): void {
        const idx = reg.pendingStateUpdates.findIndex(
            (p) => p.clusterName === update.clusterName && p.partId === update.partId,
        );
        if (idx >= 0) reg.pendingStateUpdates[idx] = update;
        else reg.pendingStateUpdates.push(update);
    }
}
