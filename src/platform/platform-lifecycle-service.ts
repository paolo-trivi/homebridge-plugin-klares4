import type { Logger } from 'homebridge';

export class PlatformLifecycleService {
    private summaryTimeout?: NodeJS.Timeout;

    constructor(private readonly log: Logger) {}

    public scheduleSummary(callback: () => void, delayMs: number): void {
        if (this.summaryTimeout) {
            clearTimeout(this.summaryTimeout);
        }

        this.summaryTimeout = setTimeout((): void => {
            callback();
            this.summaryTimeout = undefined;
        }, delayMs);
    }

    public clearSummaryTimer(): void {
        if (this.summaryTimeout) {
            clearTimeout(this.summaryTimeout);
            this.summaryTimeout = undefined;
        }
    }

    public cleanupConnections(cleanup: () => void): void {
        this.clearSummaryTimer();
        cleanup();
        this.log.debug('Platform lifecycle cleanup completed');
    }
}
