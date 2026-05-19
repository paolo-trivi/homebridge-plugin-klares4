import type { API, Logger } from 'homebridge';
import type { MatterRegistration } from './matter-registration-recovery';
import { isMatterAccessoryQueryable } from './matter-registration-recovery';

/**
 * Probe-based settle: poll `api.matter.getAccessoryState` after registration
 * until the endpoint actually answers, then resolve. Replaces the legacy fixed
 * 2-second `setTimeout` which caused early `updateAccessoryState` calls to
 * fail with "Accessory not registered or missing endpoint".
 *
 * Backoff: 250ms → 500ms → 1000ms → 1000ms ... up to `timeoutMs` total.
 * Returns `true` if the endpoint became queryable, `false` if the timeout
 * elapsed first (caller decides recovery).
 */
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INITIAL_MS = 250;
const DEFAULT_POLL_MAX_MS = 1000;

export interface ProbeOptions {
    timeoutMs?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
}

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultProbeOptions(): Required<ProbeOptions> {
    return {
        timeoutMs: envNumber('KLARES4_MATTER_REGISTER_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
        initialDelayMs: envNumber('KLARES4_MATTER_REGISTER_POLL_MS', DEFAULT_POLL_INITIAL_MS),
        maxDelayMs: envNumber('KLARES4_MATTER_REGISTER_POLL_MAX_MS', DEFAULT_POLL_MAX_MS),
    };
}

export async function probeUntilQueryable(
    api: API,
    log: Logger,
    fmtErr: (err: unknown) => string,
    reg: MatterRegistration,
    options: ProbeOptions = {},
): Promise<boolean> {
    const cfg = { ...defaultProbeOptions(), ...options };
    const deadline = Date.now() + cfg.timeoutMs;
    let delay = cfg.initialDelayMs;

    while (Date.now() < deadline) {
        if (await isMatterAccessoryQueryable(api, log, fmtErr, reg)) return true;
        await sleep(delay);
        delay = Math.min(cfg.maxDelayMs, Math.round(delay * 1.5));
    }
    // One last probe at the deadline boundary.
    return isMatterAccessoryQueryable(api, log, fmtErr, reg);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
