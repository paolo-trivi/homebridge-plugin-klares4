import type { ThermostatCfgFreshness, WebSocketClientState } from './types';

export function cfgFreshness(state: WebSocketClientState): ThermostatCfgFreshness {
    state.thermostatCfgFreshness ??= { ownWritesSinceCounter: 0, readAt: new Map() };
    return state.thermostatCfgFreshness;
}

/** `PRG_CHECK.CFG` as a number ("0000011175" → 11175), when the payload carries one. */
export function parseCfgCounter(prgCheck: unknown): number | undefined {
    if (!prgCheck || typeof prgCheck !== 'object') return undefined;
    const raw = (prgCheck as Record<string, unknown>).CFG;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return undefined;
    const counter = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(counter) ? counter : undefined;
}

/** A READ_RES CFG_THERMOSTATS just refreshed these cfg ids; its PRG_CHECK, when given, is the new baseline. */
export function recordCfgRead(state: WebSocketClientState, cfgIds: string[], prgCheck?: unknown): void {
    const freshness = cfgFreshness(state);
    const now = Date.now();
    for (const id of cfgIds) freshness.readAt.set(id, now);
    const counter = parseCfgCounter(prgCheck);
    if (counter !== undefined) {
        freshness.counter = counter;
        freshness.ownWritesSinceCounter = 0;
    }
}

export function recordOwnCfgWrite(state: WebSocketClientState): void {
    cfgFreshness(state).ownWritesSinceCounter += 1;
}

/**
 * NOT_MASK_UNSOLICITED / NM_CHANGES: the panel's cfg changed. Our own writes
 * account for part of the counter; anything beyond them (or any change when no
 * baseline is known yet) came from elsewhere (keypad, app, installer), so the
 * whole cache is dropped: the notification does not say which cfg changed.
 * The notification lags our writes by about a second and coalesces them, so a
 * counter below the expected one is ours. Returns whether the cache was dropped.
 */
export function handleCfgChangeNotification(state: WebSocketClientState, prgCheck: unknown): boolean {
    const counter = parseCfgCounter(prgCheck);
    if (counter === undefined) return false;
    const freshness = cfgFreshness(state);
    const expected = freshness.counter === undefined
        ? undefined
        : freshness.counter + freshness.ownWritesSinceCounter;
    const foreign = expected === undefined || counter > expected;
    if (foreign) {
        state.thermostatCfgById.clear();
        freshness.readAt.clear();
        freshness.counter = counter;
        freshness.ownWritesSinceCounter = 0;
    } else if (counter === expected) {
        freshness.counter = counter;
        freshness.ownWritesSinceCounter = 0;
    }
    return foreign;
}
