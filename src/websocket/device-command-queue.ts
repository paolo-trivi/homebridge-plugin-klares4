import { RetryableKlaresError } from '../errors';

/**
 * - `serial`: every command runs, in order.
 * - `latest-wins`: for outputs whose state is observable (lights, covers): a new
 *   command replaces the ones still waiting. A replaced request is not a failure
 *   (a dragged slider sends many): it is never sent and settles with the outcome
 *   of the command that replaced it, once that one is confirmed or has failed.
 * - `reject-while-busy`: for momentary outputs (gates, scenarios): a command
 *   arriving while another one is queued or running is refused at once. A pulse
 *   that times out may still have been executed: repeating it later is unsafe.
 */
export type DeviceQueuePolicy = 'serial' | 'latest-wins' | 'reject-while-busy';

export interface DeviceQueueOptions {
    policy?: DeviceQueuePolicy;
    /** A command still waiting this long after it was queued is refused instead of sent late. */
    maxWaitMs?: number;
    /** Waiting commands allowed behind the running one; more are refused. */
    maxDepth?: number;
}

/** `superseded` is no longer produced (replaced requests follow the newer one); kept for callers that name it. */
export type CommandQueueRejection = 'busy' | 'superseded' | 'expired' | 'queue-full';

export class CommandQueueRejectedError extends RetryableKlaresError {
    constructor(public readonly reason: CommandQueueRejection, key: string, detail: string) {
        super(`Command for ${key} not sent: ${detail}`);
        this.name = 'CommandQueueRejectedError';
    }
}

interface Settlement {
    resolve: () => void;
    reject: (error: Error) => void;
}

interface QueuedCommand extends Settlement {
    run: () => Promise<void>;
    /** Requests this command replaced (`latest-wins`): they share its outcome. */
    followers: Settlement[];
    expiry?: ReturnType<typeof setTimeout>;
}

interface KeyQueue {
    running: boolean;
    waiting: QueuedCommand[];
}

/** One command at a time per key (a device ID, or any key a caller chooses). */
export class DeviceCommandQueue {
    public static readonly DEFAULT_MAX_DEPTH = 4;
    private readonly queues = new Map<string, KeyQueue>();

    public enqueue(key: string, run: () => Promise<void>, options: DeviceQueueOptions = {}): Promise<void> {
        const policy = options.policy ?? 'serial';
        const queue = this.queues.get(key) ?? { running: false, waiting: [] };
        this.queues.set(key, queue);
        const busy = queue.running || queue.waiting.length > 0;
        if (busy && policy === 'reject-while-busy') {
            return Promise.reject(new CommandQueueRejectedError(
                'busy', key, 'a previous command for it is still in progress',
            ));
        }
        const replaced = policy === 'latest-wins' ? queue.waiting.splice(0) : [];
        const maxDepth = options.maxDepth ?? DeviceCommandQueue.DEFAULT_MAX_DEPTH;
        if (queue.waiting.length >= maxDepth) {
            const full = new CommandQueueRejectedError('queue-full', key, `${maxDepth} command(s) already waiting`);
            for (const older of replaced) this.drop(older, full);
            return Promise.reject(full);
        }
        return new Promise<void>((resolve, reject) => {
            const entry: QueuedCommand = { run, resolve, reject, followers: [] };
            for (const older of replaced) {
                if (older.expiry) clearTimeout(older.expiry);
                entry.followers.push(...older.followers, { resolve: older.resolve, reject: older.reject });
            }
            if (busy && options.maxWaitMs !== undefined) {
                const maxWaitMs = options.maxWaitMs;
                entry.expiry = setTimeout((): void => {
                    const index = queue.waiting.indexOf(entry);
                    if (index < 0) return;
                    queue.waiting.splice(index, 1);
                    this.drop(entry, new CommandQueueRejectedError(
                        'expired', key, `still queued after ${maxWaitMs}ms`,
                    ));
                }, maxWaitMs);
            }
            queue.waiting.push(entry);
            if (!queue.running) this.runNext(key, queue);
        });
    }

    /** Commands queued or running for `key`. */
    public size(key: string): number {
        const queue = this.queues.get(key);
        return queue ? queue.waiting.length + (queue.running ? 1 : 0) : 0;
    }

    /** Refuses every waiting command; the running ones end on their own (their sends fail). */
    public rejectWaiting(error: Error): void {
        for (const queue of this.queues.values()) {
            for (const entry of queue.waiting.splice(0)) this.drop(entry, error);
        }
    }

    private runNext(key: string, queue: KeyQueue): void {
        const entry = queue.waiting.shift();
        if (!entry) {
            queue.running = false;
            if (this.queues.get(key) === queue) this.queues.delete(key);
            return;
        }
        if (entry.expiry) clearTimeout(entry.expiry);
        queue.running = true;
        let result: Promise<void>;
        try {
            result = entry.run();
        } catch (error) {
            result = Promise.reject(error);
        }
        // The queue moves on before the caller resumes: a caller that awaited this
        // command and sends the next one at once must not find the device busy.
        result.then((): void => {
            this.runNext(key, queue);
            // Oldest first, the command that ran last: a caller that stores the value it
            // asked for (HAP accessory cache) ends up with the value really sent.
            for (const settlement of [...entry.followers, entry]) settlement.resolve();
        }, (error: unknown): void => {
            this.runNext(key, queue);
            this.drop(entry, error instanceof Error ? error : new Error(String(error)));
        });
    }

    private drop(entry: QueuedCommand, error: Error): void {
        if (entry.expiry) clearTimeout(entry.expiry);
        for (const settlement of [entry, ...entry.followers]) settlement.reject(error);
    }
}
