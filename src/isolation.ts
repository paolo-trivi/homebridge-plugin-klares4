import type { Logger } from 'homebridge';

/** Stack when there is one: an isolated failure must say where it happened. */
export function errorDetail(error: unknown): string {
    if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
    return String(error);
}

/**
 * Runs `fn` so that its failure costs only itself: the exception is logged
 * at error level with `context` and the stack, and does not propagate. Used
 * per frame element and per consumer, so one malformed entry or one failing
 * consumer never drops the rest of a panel frame.
 */
export function runIsolated(log: Logger, context: string, fn: () => void): void {
    try {
        fn();
    } catch (error: unknown) {
        log.error(`${context} failed: ${errorDetail(error)}`);
    }
}

/** The panel `ID` of a raw frame element, for logs; `?` when there is none. */
export function rawItemId(item: unknown): string {
    if (item !== null && typeof item === 'object' && 'ID' in item) {
        return String((item as { ID: unknown }).ID);
    }
    return '?';
}

/**
 * `for...of` over the elements of a frame section, each one isolated. Without
 * a logger (bare unit-test wiring) a failure propagates as before.
 */
export function forEachIsolated<T>(
    log: Logger | undefined,
    label: string,
    items: Iterable<T>,
    fn: (item: T) => void,
): void {
    for (const item of items) {
        if (log) {
            runIsolated(log, `${label} ${rawItemId(item)}`, () => fn(item));
        } else {
            fn(item);
        }
    }
}
