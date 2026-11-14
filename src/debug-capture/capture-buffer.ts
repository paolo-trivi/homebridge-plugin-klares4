import type { RawMessage } from './types';

export interface CaptureLimits {
    maxMessages: number;
    /** Sum of the stored frames' sizes in UTF-8 bytes; the file written from them is a few times larger. */
    maxBytes: number;
}

/** Real traffic is about 4 MB in 15 minutes: these hold more than the longest capture (30 minutes). */
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = { maxMessages: 20_000, maxBytes: 8 * 1024 * 1024 };

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
