import type { Logger } from 'homebridge';

const DEFAULT_WINDOW_MS = 60_000;

/**
 * Warnings caused by what other clients publish (bad topics, bad payloads,
 * command floods) are rate limited per kind: a flood of bad messages costs
 * one log line per minute, with the count of the ones left out.
 */
export class ThrottledWarnings {
    private readonly windows = new Map<string, { until: number; suppressed: number }>();

    constructor(
        private readonly log: Logger,
        private readonly windowMs: number = DEFAULT_WINDOW_MS,
        private readonly now: () => number = Date.now,
    ) {}

    public warn(kind: string, message: string): void {
        const now = this.now();
        const window = this.windows.get(kind);
        if (window && now < window.until) {
            window.suppressed += 1;
            this.log.debug(message);
            return;
        }
        const suppressed = window?.suppressed ?? 0;
        this.windows.set(kind, { until: now + this.windowMs, suppressed: 0 });
        this.log.warn(suppressed > 0 ? `${message} (${suppressed} similar message(s) not logged)` : message);
    }
}
