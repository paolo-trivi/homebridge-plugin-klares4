import type { ThermostatWriteIntent } from './thermostat-command-payload';

/** One WRITE_CFG in the making: every command for the cfg merged into it until it is sealed. */
export interface ThermostatWriteBatch {
    readonly cfgId: string;
    readonly intent: ThermostatWriteIntent;
    /** Called right before the payload is built: later commands start a new batch. */
    seal(): void;
}

interface ThermostatWriteBatcherDeps {
    /** Serializes tasks per key (the dispatcher's device queue). */
    enqueue: (key: string, task: () => Promise<void>) => Promise<void>;
    execute: (batch: ThermostatWriteBatch) => Promise<void>;
    /** How long a batch waits for more commands before it runs. */
    coalesceMs: number;
}

interface PendingBatch extends ThermostatWriteBatch {
    intent: ThermostatWriteIntent;
    waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

/**
 * Thermostat writes are serialized per cfg id, not per accessory: the heating
 * and the cooling output of one program share a cfg, and two writes to it must
 * not interleave. Commands that arrive while a write is waiting (a scene that
 * sets mode and setpoint, a slider sending several values) are merged into it:
 * the latest mode and the latest setpoint go out together in one WRITE_CFG, so
 * the order in which HomeKit or Matter delivers them no longer matters. Every
 * merged command settles with the outcome of that write.
 */
export class ThermostatWriteBatcher {
    private readonly open = new Map<string, PendingBatch>();

    constructor(private readonly deps: ThermostatWriteBatcherDeps) {}

    public submit(cfgId: string, change: ThermostatWriteIntent): Promise<void> {
        const existing = this.open.get(cfgId);
        const batch = existing ?? this.createBatch(cfgId);
        if (change.mode !== undefined) batch.intent.mode = change.mode;
        if (change.temperature !== undefined) batch.intent.temperature = change.temperature;
        const settled = new Promise<void>((resolve, reject) => { batch.waiters.push({ resolve, reject }); });
        if (!existing) {
            this.open.set(cfgId, batch);
            this.deps.enqueue(`thermostat-cfg:${cfgId}`, () => this.run(batch)).then(
                () => { for (const waiter of batch.waiters) waiter.resolve(); },
                (error: unknown) => { for (const waiter of batch.waiters) waiter.reject(error); },
            ).finally(() => batch.seal());
        }
        return settled;
    }

    private createBatch(cfgId: string): PendingBatch {
        const batch: PendingBatch = {
            cfgId,
            intent: {},
            waiters: [],
            seal: (): void => {
                if (this.open.get(cfgId) === batch) this.open.delete(cfgId);
            },
        };
        return batch;
    }

    private async run(batch: PendingBatch): Promise<void> {
        if (this.deps.coalesceMs > 0) {
            await new Promise<void>((resolve) => { setTimeout(resolve, this.deps.coalesceMs); });
        }
        await this.deps.execute(batch);
    }
}
