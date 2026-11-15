import type { API, Logger, MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import type { PendingMatterStateUpdate } from './matter-state-updates';

export type MatterRegistrationStatus = 'pending' | 'registered' | 'failed' | 'skipped';

export interface MatterRegistration {
    uuid: string;
    displayName: string;
    deviceType: string;
    matterAccessory: MatterAccessory;
    status: MatterRegistrationStatus;
    registeredAt?: number;
    stateUpdatesReadyAt?: number;
    failedAt?: number;
    lastError?: string;
    recoveryAttempts: number;
    pendingStateUpdates: PendingMatterStateUpdate[];
    /**
     * displayName last pushed to matter.js via `registerPlatformAccessories`.
     * This is the name the live endpoint (and the controllers) actually hold —
     * unlike `matterAccessory.displayName`, which in-memory re-mapping may
     * update without any push. The name-map finalize pass diffs against this.
     */
    registeredDisplayName?: string;
    /** Set when the failure was transient: earliest time a new update may retry the registration. */
    retryAfter?: number;
    /**
     * `uniqueId` of the endpoint this registration replaces, given back to the
     * new endpoint once it answers (see `matter-endpoint-replacement.ts`).
     */
    inheritedUniqueId?: string;
}

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
    /** Wait after an unregistered endpoint first reads as absent, before it is checked again (topology coordinator). */
    unregisterSettleMs: number;
    /** Longest wait for the thermostat programs before a thermostat registers with the role from its name. */
    thermostatRoleWaitMs: number;
}

const TIMING_DEFAULTS: Record<keyof MatterTimings, { env: string; value: number; allowZero: boolean }> = {
    registerProbeTimeoutMs: { env: 'KLARES4_MATTER_REGISTER_TIMEOUT_MS', value: 30_000, allowZero: false },
    settledRegisterProbeTimeoutMs: { env: 'KLARES4_MATTER_SETTLED_REGISTER_TIMEOUT_MS', value: 2_000, allowZero: false },
    registerProbePollMs: { env: 'KLARES4_MATTER_REGISTER_POLL_MS', value: 250, allowZero: false },
    registerProbePollMaxMs: { env: 'KLARES4_MATTER_REGISTER_POLL_MAX_MS', value: 1_000, allowZero: false },
    registerRetryMs: { env: 'KLARES4_MATTER_REGISTER_RETRY_MS', value: 5_000, allowZero: true },
    stateBootstrapMs: { env: 'KLARES4_MATTER_STATE_BOOTSTRAP_MS', value: 0, allowZero: true },
    unreachableGraceMs: { env: 'KLARES4_MATTER_UNREACHABLE_GRACE_MS', value: 15_000, allowZero: true },
    unregisterSettleMs: { env: 'KLARES4_MATTER_UNREGISTER_SETTLE_MS', value: 1_000, allowZero: true },
    thermostatRoleWaitMs: { env: 'KLARES4_MATTER_THERMOSTAT_ROLE_WAIT_MS', value: 20_000, allowZero: true },
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
        unregisterSettleMs: pick('unregisterSettleMs'),
        thermostatRoleWaitMs: pick('thermostatRoleWaitMs'),
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
