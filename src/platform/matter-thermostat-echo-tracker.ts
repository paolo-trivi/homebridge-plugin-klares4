/**
 * Per-plugin tracker of Matter Thermostat attribute values we have most recently
 * pushed to matter.js via `api.matter.updateAccessoryState(...)`.
 *
 * Why this exists
 * ---------------
 * matter.js (as bundled with Homebridge 2 beta) re-fires attribute-change handlers
 * even for writes that originated from the plugin itself via `updateAccessoryState`.
 * Without an origin-tracking guard, every internal push becomes an "external"
 * setpoint/systemMode command which is forwarded to the Lares4 centrale, whose
 * subsequent CFG broadcast re-pushes the same attribute, which re-fires the
 * handler — a self-sustaining loop that hammers the centrale every ~2-3 s and
 * eventually times out WRITE_CFG (`Command timed out after 2500ms`).
 *
 * The previous closure-scoped `ThermostatEchoGuard` (matter-thermostat-mapper.ts)
 * could not catch this because:
 *   - it only recorded *outgoing handler-side writes*, not the plugin's own pushes;
 *   - it was recreated on every `refreshAccessoryMetadata`, losing its state;
 *   - it did not cover `systemMode`, only setpoints.
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
}

export class MatterThermostatEchoTracker {
    private readonly ttlMs: number;
    private readonly entries = new Map<string, Entry>();
    private readonly confirmed = new Map<string, ConfirmedEntry>();

    constructor(
        ttlMs = DEFAULT_ECHO_TTL_MS,
        private readonly now: () => number = Date.now,
        private readonly confirmedTtlMs = DEFAULT_CONFIRMED_TTL_MS,
    ) {
        this.ttlMs = ttlMs;
    }

    /**
     * Record the most recent value the plugin pushed to matter.js for the given
     * thermostat. Subsequent handler callbacks with the same value are echoes
     * and must be ignored.
     */
    recordPushed(uuid: string, attrs: Record<string, unknown>): void {
        const now = this.now();
        for (const attr of ['occupiedHeatingSetpoint', 'occupiedCoolingSetpoint', 'systemMode'] as TrackedAttr[]) {
            const v = attrs[attr];
            if (typeof v === 'number' && Number.isFinite(v)) {
                this.entries.set(this.key(uuid, attr), { value: v, at: now });
            }
        }
    }

    /**
     * Manually record a single attribute. Used by handlers that send commands
     * to Lares4 so the centrale's echo (and matter.js's re-fire of it) is suppressed.
     */
    recordIntent(uuid: string, attr: TrackedAttr, value: number): void {
        this.entries.set(this.key(uuid, attr), { value, at: this.now() });
    }

    /**
     * True when the handler is being invoked with a value the plugin itself
     * just wrote — meaning this is matter.js re-firing our own push, not a
     * controller-initiated command.
     */
    isEcho(uuid: string, attr: TrackedAttr, value: number): boolean {
        const e = this.entries.get(this.key(uuid, attr));
        if (!e) return false;
        if (this.now() - e.at > this.ttlMs) {
            this.entries.delete(this.key(uuid, attr));
            return false;
        }
        return e.value === value;
    }

    /**
     * Drop the tracked entry once consumed. Some matter.js versions fire the
     * handler exactly once per push — keeping the entry after consumption would
     * suppress a *legitimate* controller command that happens to land on the
     * same value within the TTL window. For safety we don't aggressively expire:
     * isEcho compares value AND key, and TTL bounds the worst case. Callers may
     * still invoke this to be explicit.
     */
    consume(uuid: string, attr: TrackedAttr): void {
        this.entries.delete(this.key(uuid, attr));
    }

    /**
     * Record a target (°C) or mode the panel acknowledged for a Matter command
     * (TH-08). The device snapshot changes only with the realtime that follows
     * the ACK; until then this is the newer truth.
     */
    recordConfirmed(uuid: string, attr: 'target', value: number): void;
    recordConfirmed(uuid: string, attr: 'mode', value: ThermostatModeValue): void;
    recordConfirmed(uuid: string, attr: ConfirmedAttr, value: number | string): void {
        this.confirmed.set(this.confirmedKey(uuid, attr), { value: normalize(value), at: this.now() });
    }

    /** The target to compare a new command against: see `effectiveValue`. */
    effectiveTarget(uuid: string, observed: number | undefined): number | undefined {
        const value = this.effectiveValue(uuid, 'target', observed);
        return typeof value === 'number' ? value / 100 : observed;
    }

    /** The mode to compare a new command against: see `effectiveValue`. */
    effectiveMode(uuid: string, observed: ThermostatModeValue | undefined): ThermostatModeValue | undefined {
        const value = this.effectiveValue(uuid, 'mode', observed);
        return typeof value === 'string' ? value as ThermostatModeValue : observed;
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
     * `observed` (normalized). The entry ends when the realtime reports the
     * acknowledged value, or after its TTL.
     */
    private effectiveValue(uuid: string, attr: ConfirmedAttr, observed: number | string | undefined): number | string | undefined {
        const key = this.confirmedKey(uuid, attr);
        const entry = this.confirmed.get(key);
        const seen = observed === undefined ? undefined : normalize(observed);
        if (!entry) return seen;
        if (this.now() - entry.at > this.confirmedTtlMs || seen === entry.value) {
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
