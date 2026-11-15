/**
 * Per-plugin tracker of Matter Thermostat attribute values we have most recently
 * pushed to matter.js via `api.matter.updateAccessoryState(...)`.
 *
 * Why this exists
 * ---------------
 * matter.js (as bundled with Homebridge 2 beta) re-fires attribute-change handlers
 * even for writes that originated from the plugin itself via `updateAccessoryState`.
 * Without an origin-tracking guard, every internal push becomes an "external"
 * setpoint/systemMode command which is forwarded to the Lares4 panel, whose
 * subsequent CFG broadcast re-pushes the same attribute, which re-fires the
 * handler — a self-sustaining loop that hammers the panel every ~2-3 s and
 * eventually times out WRITE_CFG (`Command timed out after 2500ms`).
 *
 * A guard scoped to one handler closure cannot catch this: it has to record
 * the plugin's own pushes as well as the handler-side writes, survive a
 * metadata refresh of the accessory, and cover `systemMode` as well as the
 * setpoints. Hence one tracker per registry.
 *
 * Responsibilities (small, deliberately):
 *   - `recordPushed(uuid, attrs)`  — call before/right after `updateAccessoryState`
 *     for thermostat cluster updates;
 *   - `isEcho(uuid, attr, value)`  — handlers check this before forwarding to WS;
 *   - `isIdempotent(uuid, attr, value)` — short-circuit when the requested value
 *     already matches the most recent push (so re-pushes during a transient WS
 *     glitch never trigger a WRITE_CFG).
 *
 * One instance per `MatterAccessoryRegistry`. Keyed by accessory UUID. Stored
 * values are Matter-encoded (centidegrees for setpoints, SystemModeEnum int for
 * mode) so comparison is exact and unit-free.
 */

import type { ThermostatOutputRole } from '../types';

const DEFAULT_ECHO_TTL_MS = 10_000;
/**
 * How long a value confirmed by the panel's ACK stands in for the realtime
 * state. The realtime follows the ACK by about 2 s (capture); the bound only
 * matters when it never comes.
 */
const DEFAULT_CONFIRMED_TTL_MS = 15_000;

type TrackedAttr = 'occupiedHeatingSetpoint' | 'occupiedCoolingSetpoint' | 'systemMode';

interface Entry {
    value: number;
    at: number;
}

type ConfirmedAttr = 'target' | 'mode';
type ThermostatModeValue = 'off' | 'heat' | 'cool' | 'auto';

/** Targets are kept in centidegrees so 21 and 21.0000001 compare equal. */
const normalize = (value: number | string): number | string => (typeof value === 'number' ? Math.round(value * 100) : value);

interface ConfirmedEntry {
    value: number | string;
    at: number;
    /** `status.observedSeq` when the ACK was seen: the last realtime observation it is newer than. */
    afterSeq: number | undefined;
}

/**
 * The device's latest realtime observation: `seq` is the client's event
 * sequence number (`status.observedSeq`), `at` its time (`status.observedAt`).
 */
export interface RealtimeObservation {
    seq?: number;
    at?: number;
}

export class MatterThermostatEchoTracker {
    private readonly ttlMs: number;
    /** Per accessory and attribute: the values pushed (or intended) and not yet seen fired, oldest first. */
    private readonly entries = new Map<string, Entry[]>();
    private readonly confirmed = new Map<string, ConfirmedEntry>();
    private readonly roles = new Map<string, ThermostatOutputRole>();

    constructor(
        ttlMs = DEFAULT_ECHO_TTL_MS,
        private readonly now: () => number = Date.now,
        private readonly confirmedTtlMs = DEFAULT_CONFIRMED_TTL_MS,
    ) {
        this.ttlMs = ttlMs;
    }

    /**
     * Record the values the plugin is about to push to matter.js for the
     * given thermostat. A handler callback with one of them is an echo.
     * `current` is the cluster state Homebridge holds for the endpoint (it
     * follows applied pushes and controller writes): a value equal to it
     * changes nothing and fires no handler, so it is not recorded, and it
     * cannot later swallow a controller write of that value.
     */
    recordPushed(uuid: string, attrs: Record<string, unknown>, current?: Record<string, unknown>): void {
        for (const attr of ['occupiedHeatingSetpoint', 'occupiedCoolingSetpoint', 'systemMode'] as TrackedAttr[]) {
            const v = attrs[attr];
            if (typeof v === 'number' && Number.isFinite(v) && current?.[attr] !== v) this.record(uuid, attr, v);
        }
    }

    /**
     * Record a single attribute a handler is about to send to Lares4, so the
     * panel's echo (and matter.js's re-fire of it) is suppressed.
     */
    recordIntent(uuid: string, attr: TrackedAttr, value: number): void {
        this.record(uuid, attr, value);
    }

    /**
     * True when the handler is invoked with a value the plugin itself pushed:
     * matter.js re-firing our own push, not a controller command. Pushes are
     * applied in order, so the match and every older value are used up; a
     * value newer than the match stays (L2: an initial push applied after a
     * controller write is recognised, and the write is not undone).
     */
    isEcho(uuid: string, attr: TrackedAttr, value: number): boolean {
        const list = this.live(uuid, attr);
        const idx = list.findIndex((e) => e.value === value);
        if (idx < 0) return false;
        list.splice(0, idx + 1);
        return true;
    }

    /** Drop every tracked value of the attribute (after a failed command, F33). */
    consume(uuid: string, attr: TrackedAttr): void {
        this.entries.delete(this.key(uuid, attr));
    }

    private record(uuid: string, attr: TrackedAttr, value: number): void {
        const list = this.live(uuid, attr);
        const last = list[list.length - 1];
        // The same value again changes nothing on the endpoint: no new fire to expect.
        if (last?.value === value) last.at = this.now();
        else list.push({ value, at: this.now() });
        this.entries.set(this.key(uuid, attr), list);
    }

    private live(uuid: string, attr: TrackedAttr): Entry[] {
        const key = this.key(uuid, attr);
        const now = this.now();
        const list = (this.entries.get(key) ?? []).filter((e) => now - e.at <= this.ttlMs);
        if (list.length > 0) this.entries.set(key, list);
        else this.entries.delete(key);
        return list;
    }

    /**
     * Record a target (°C) or mode the panel acknowledged for a Matter command
     * (TH-08). The device snapshot changes only with the realtime that follows
     * the ACK; until then this is the newer truth. `observedSeq` is the
     * device's `status.observedSeq` at that moment.
     */
    recordConfirmed(uuid: string, attr: 'target', value: number, observedSeq?: number): void;
    recordConfirmed(uuid: string, attr: 'mode', value: ThermostatModeValue, observedSeq?: number): void;
    recordConfirmed(uuid: string, attr: ConfirmedAttr, value: number | string, observedSeq?: number): void {
        this.confirmed.set(this.confirmedKey(uuid, attr), { value: normalize(value), at: this.now(), afterSeq: observedSeq });
    }

    /** The target to compare a new command against: see `effectiveValue`. */
    effectiveTarget(uuid: string, observed: number | undefined, observation: RealtimeObservation = {}): number | undefined {
        const value = this.effectiveValue(uuid, 'target', observed, observation);
        return typeof value === 'number' ? value / 100 : observed;
    }

    /** The mode to compare a new command against: see `effectiveValue`. */
    effectiveMode(uuid: string, observed: ThermostatModeValue | undefined, observation: RealtimeObservation = {}): ThermostatModeValue | undefined {
        const value = this.effectiveValue(uuid, 'mode', observed, observation);
        return typeof value === 'string' ? value as ThermostatModeValue : observed;
    }

    /**
     * The role a registered Thermostat endpoint was built for. State updates
     * and command handling follow the live endpoint's attribute set, not a
     * role learned later: matter.js rolls back an update that carries an
     * attribute the endpoint does not have, and every value of that update is
     * lost (rc.1 H1). A changed role is applied by replacing the endpoint.
     */
    registeredRole(uuid: string): ThermostatOutputRole | undefined {
        return this.roles.get(uuid);
    }

    setRegisteredRole(uuid: string, role: ThermostatOutputRole | undefined): void {
        if (role) this.roles.set(uuid, role);
        else this.roles.delete(uuid);
    }

    /** Clear all entries for an accessory (use on unregister / device removal). */
    clear(uuid: string): void {
        for (const map of [this.entries, this.confirmed] as Map<string, unknown>[]) {
            for (const k of Array.from(map.keys())) {
                if (k.startsWith(`${uuid}::`)) map.delete(k);
            }
        }
    }

    /**
     * The acknowledged value while the realtime has not caught up with it, else
     * `observed` (normalized). The entry ends at the first realtime observation
     * after the ACK, whatever it reports: from then on the panel's own report
     * is newer, also when another source (keypad, HomeKit) changed the value
     * (M1). "After" is decided by the client's event sequence
     * (`status.observedSeq`), never by the clock: an ACK and a realtime often
     * share a millisecond. A state without sequence numbers (an older client,
     * a hand-built state) falls back on `observedAt`; it also ends when the
     * realtime reports the acknowledged value, and in any case after the TTL
     * (an expiry, not an ordering).
     */
    private effectiveValue(
        uuid: string, attr: ConfirmedAttr, observed: number | string | undefined, observation: RealtimeObservation,
    ): number | string | undefined {
        const key = this.confirmedKey(uuid, attr);
        const entry = this.confirmed.get(key);
        const seen = observed === undefined ? undefined : normalize(observed);
        if (!entry) return seen;
        if (this.now() - entry.at > this.confirmedTtlMs || seen === entry.value || newerObservation(entry, observation)) {
            this.confirmed.delete(key);
            return seen;
        }
        return entry.value;
    }

    private confirmedKey(uuid: string, attr: ConfirmedAttr): string {
        return `${uuid}::confirmed::${attr}`;
    }

    private key(uuid: string, attr: TrackedAttr): string {
        return `${uuid}::${attr}`;
    }
}

/** A realtime observation processed after the entry's ACK. */
function newerObservation(entry: ConfirmedEntry, observation: RealtimeObservation): boolean {
    if (observation.seq !== undefined) return entry.afterSeq === undefined || observation.seq > entry.afterSeq;
    return observation.at !== undefined && observation.at > entry.at;
}
