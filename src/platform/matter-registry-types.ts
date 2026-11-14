import type { API, Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';

export type MatterRegistrationStatus = 'pending' | 'registered' | 'failed' | 'skipped';

/**
 * Timings of the Matter registration path. Each one defaults to its
 * `KLARES4_MATTER_*` environment variable (read when the registry is built,
 * kept for compatibility), then to the built-in value.
 */
export interface MatterTimings {
    /** Budget for a new endpoint to answer when the runtime has not shown that register waits for it. */
    registerProbeTimeoutMs: number;
    /** Budget once the runtime has shown that register resolves with the endpoint already built. */
    settledRegisterProbeTimeoutMs: number;
    registerProbePollMs: number;
    registerProbePollMaxMs: number;
    /** Wait before a register refused as transient ("still starting") may be retried. */
    registerRetryMs: number;
    /** Extra delay before state updates reach a freshly registered endpoint (emergency override). */
    stateBootstrapMs: number;
    /** How long the panel may stay unreachable before the endpoints are marked unreachable. */
    unreachableGraceMs: number;
}

const TIMING_DEFAULTS: Record<keyof MatterTimings, { env: string; value: number; allowZero: boolean }> = {
    registerProbeTimeoutMs: { env: 'KLARES4_MATTER_REGISTER_TIMEOUT_MS', value: 30_000, allowZero: false },
    settledRegisterProbeTimeoutMs: { env: 'KLARES4_MATTER_SETTLED_REGISTER_TIMEOUT_MS', value: 2_000, allowZero: false },
    registerProbePollMs: { env: 'KLARES4_MATTER_REGISTER_POLL_MS', value: 250, allowZero: false },
    registerProbePollMaxMs: { env: 'KLARES4_MATTER_REGISTER_POLL_MAX_MS', value: 1_000, allowZero: false },
    registerRetryMs: { env: 'KLARES4_MATTER_REGISTER_RETRY_MS', value: 5_000, allowZero: true },
    stateBootstrapMs: { env: 'KLARES4_MATTER_STATE_BOOTSTRAP_MS', value: 0, allowZero: true },
    unreachableGraceMs: { env: 'KLARES4_MATTER_UNREACHABLE_GRACE_MS', value: 15_000, allowZero: true },
};

function usable(value: unknown, allowZero: boolean): value is number {
    return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
}

/** Explicit options win, then the environment, then the built-in default. */
export function resolveMatterTimings(
    overrides: Partial<MatterTimings> = {},
    env: NodeJS.ProcessEnv = process.env,
): MatterTimings {
    const pick = (key: keyof MatterTimings): number => {
        const { env: name, value, allowZero } = TIMING_DEFAULTS[key];
        const raw = env[name];
        const fromEnv = raw === undefined || raw.trim() === '' ? undefined : Number(raw);
        const explicit = overrides[key];
        if (usable(explicit, allowZero)) return explicit;
        return usable(fromEnv, allowZero) ? fromEnv : value;
    };
    return {
        registerProbeTimeoutMs: pick('registerProbeTimeoutMs'),
        settledRegisterProbeTimeoutMs: pick('settledRegisterProbeTimeoutMs'),
        registerProbePollMs: pick('registerProbePollMs'),
        registerProbePollMaxMs: pick('registerProbePollMaxMs'),
        registerRetryMs: pick('registerRetryMs'),
        stateBootstrapMs: pick('stateBootstrapMs'),
        unreachableGraceMs: pick('unreachableGraceMs'),
    };
}

export interface MatterRegistryDeps {
    api: API;
    log: Logger;
    getWsClient: () => KseniaWebSocketClient | undefined;
    storagePath: string;
    momentaryAutoOffMs?: number;
    isDeviceExposed?: (device: KseniaDevice) => boolean;
    recoveryRequests?: Record<string, number>;
    /** Overrides the unregister observation budget; see the coordinator. */
    unregisterTimeoutMs?: number;
    /** Overrides of the registration timings (tests use a few milliseconds). */
    timings?: Partial<MatterTimings>;
}
