import type { RawMessage } from './types';

export interface CaptureLimits {
    maxMessages: number;
    /** Sum of the stored frames' sizes in UTF-8 bytes; the file holds each frame once. */
    maxBytes: number;
}

/**
 * The frames of a real 10-15 minute capture weigh 0.15-0.3 MB (the snapshots are the bulk of
 * the file), so 2 MiB is about eight times the largest one seen. The file is written in one
 * synchronous step at shutdown and is meant to be sent privately, so it has to stay a few MiB.
 */
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = { maxMessages: 5_000, maxBytes: 2 * 1024 * 1024 };

/**
 * The frames of a capture in progress. When a limit is reached the earliest frames
 * (login, discovery) are kept and the later ones are counted, not stored: the file
 * is built from this buffer in one synchronous step, so its size must be bounded.
 */
export class CaptureBuffer {
    public readonly messages: RawMessage[] = [];
    public dropped = 0;
    private bytes = 0;

    constructor(private readonly limits: CaptureLimits) {}

    /** False when the frame did not fit and was only counted. */
    public tryAdd(message: RawMessage): boolean {
        const size = Buffer.byteLength(message.rawData);
        if (this.messages.length >= this.limits.maxMessages || this.bytes + size > this.limits.maxBytes) {
            this.dropped += 1;
            return false;
        }
        this.bytes += size;
        this.messages.push(message);
        return true;
    }
}
