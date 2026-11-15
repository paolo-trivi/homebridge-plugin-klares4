import type { API, Logger } from 'homebridge';
import type { MatterRegistration } from './matter-registration-recovery';
import type { PendingMatterStateUpdate } from './matter-state-updates';
import { MatterCommandGuard } from './matter-command-guard';

/** Retry interval of a flush held back by a Matter command on the endpoint. */
const HELD_RETRY_MS = 10;

export class MatterStateUpdateQueue {
    private readonly flushTimers = new Map<string, NodeJS.Timeout>();

    constructor(
        private readonly api: API,
        private readonly log: Logger,
        private readonly registrations: Map<string, MatterRegistration>,
        private readonly fmtErr: (err: unknown) => string,
        /**
         * Invoked just before `api.matter.updateAccessoryState`: returns the
         * attributes to push (a thermostat update is rebuilt from the latest
         * state) and lets the registry record them (the thermostat echo tracker
         * recognises its own state echo when matter.js re-fires the handlers).
         */
        private readonly onBeforePush?: (reg: MatterRegistration, update: PendingMatterStateUpdate) => Record<string, unknown>,
    ) {
        this.commands = new MatterCommandGuard(api);
    }

    /** Serializes this queue's pushes with the controller commands on each endpoint. */
    public readonly commands: MatterCommandGuard;

    /**
     * The endpoint answered the probe, so no bootstrap delay is needed;
     * `delayMs` (`MatterTimings.stateBootstrapMs`) stays as an emergency override.
     */
    public markReadyAfterBootstrap(reg: MatterRegistration, delayMs: number): void {
        reg.stateUpdatesReadyAt = Date.now() + delayMs;
    }

    public async pushOrQueue(
        reg: MatterRegistration,
        update: PendingMatterStateUpdate,
    ): Promise<void> {
        if (!this.isReadyForStateUpdates(reg) || this.commands.isBusy(reg.uuid)) {
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
        if (this.commands.isBusy(uuid)) {
            const timer = setTimeout(() => {
                this.flushTimers.delete(uuid);
                void this.flush(uuid);
            }, HELD_RETRY_MS);
            this.flushTimers.set(uuid, timer);
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
            const attributes = this.onBeforePush?.(reg, update) ?? update.attributes;
            this.commands.notePush(reg.uuid, update.clusterName, attributes, () => reg.matterAccessory.clusters?.[update.clusterName]);
            await this.api.matter!.updateAccessoryState(reg.uuid, update.clusterName, attributes, update.partId);
        } catch (err) {
            // Lost values are not a debug matter: the endpoint shows a stale state until the next update.
            this.log.warn(`[Matter] state update refused for ${reg.displayName} (${update.clusterName}): ${this.fmtErr(err)}`);
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
