import type { API, Logger } from 'homebridge';
import type { MatterRegistration } from './matter-registration-recovery';
import type { PendingMatterStateUpdate } from './matter-state-updates';

const MATTER_STATE_UPDATE_RETRY_MS = 5000;
const MATTER_STATE_UPDATE_RETRY_LIMIT = 6;

export class MatterStateUpdateQueue {
    constructor(
        private readonly api: API,
        private readonly log: Logger,
        private readonly registrations: Map<string, MatterRegistration>,
        private readonly fmtErr: (err: unknown) => string,
    ) {}

    public async pushOrQueue(
        reg: MatterRegistration,
        update: PendingMatterStateUpdate,
        attempt = 0,
    ): Promise<void> {
        if (!await this.isClusterQueryable(reg, update)) {
            this.queue(reg, update);
            this.scheduleFlush(reg.uuid, attempt + 1);
            return;
        }

        this.api.matter!.updateAccessoryState(reg.uuid, update.clusterName, update.attributes, update.partId);
    }

    public scheduleFlush(uuid: string, attempt: number): void {
        const reg = this.registrations.get(uuid);
        if (!reg || reg.pendingStateUpdates.length === 0) return;

        if (attempt > MATTER_STATE_UPDATE_RETRY_LIMIT) {
            this.log.warn(
                `[Matter] pending state updates dropped for ${reg.displayName}: Matter endpoint was not ready `
                + `after ${MATTER_STATE_UPDATE_RETRY_LIMIT} retries.`,
            );
            reg.pendingStateUpdates = [];
            return;
        }

        const delay = attempt === 0 ? MATTER_STATE_UPDATE_RETRY_MS : MATTER_STATE_UPDATE_RETRY_MS * attempt;
        setTimeout(() => { void this.flush(uuid, attempt); }, delay);
    }

    private async flush(uuid: string, attempt: number): Promise<void> {
        const reg = this.registrations.get(uuid);
        if (!reg || reg.status !== 'registered' || reg.pendingStateUpdates.length === 0) return;

        const pending = reg.pendingStateUpdates.splice(0);
        this.log.debug(`[Matter] pending updates flush attempt ${attempt + 1}: ${reg.displayName} (${pending.length})`);
        for (const update of pending) {
            await this.pushOrQueue(reg, update, attempt);
        }
    }

    private async isClusterQueryable(reg: MatterRegistration, update: PendingMatterStateUpdate): Promise<boolean> {
        try {
            const current = await this.api.matter!.getAccessoryState(reg.uuid, update.clusterName, update.partId);
            return current !== undefined;
        } catch (err) {
            this.log.debug(`[Matter] state probe failed for ${reg.displayName} (${update.clusterName}): ${this.fmtErr(err)}`);
            return false;
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
