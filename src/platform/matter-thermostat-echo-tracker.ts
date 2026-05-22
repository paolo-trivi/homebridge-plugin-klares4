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

type TrackedAttr = 'occupiedHeatingSetpoint' | 'occupiedCoolingSetpoint' | 'systemMode';

interface Entry {
    value: number;
    at: number;
}

export class MatterThermostatEchoTracker {
    private readonly ttlMs: number;
    private readonly entries = new Map<string, Entry>();

    constructor(ttlMs = DEFAULT_ECHO_TTL_MS) {
        this.ttlMs = ttlMs;
    }

    /**
     * Record the most recent value the plugin pushed to matter.js for the given
     * thermostat. Subsequent handler callbacks with the same value are echoes
     * and must be ignored.
     */
    recordPushed(uuid: string, attrs: Record<string, unknown>): void {
        const now = Date.now();
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
        this.entries.set(this.key(uuid, attr), { value, at: Date.now() });
    }

    /**
     * True when the handler is being invoked with a value the plugin itself
     * just wrote — meaning this is matter.js re-firing our own push, not a
     * controller-initiated command.
     */
    isEcho(uuid: string, attr: TrackedAttr, value: number): boolean {
        const e = this.entries.get(this.key(uuid, attr));
        if (!e) return false;
        if (Date.now() - e.at > this.ttlMs) {
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

    /** Clear all entries for an accessory (use on unregister / device removal). */
    clear(uuid: string): void {
        for (const k of Array.from(this.entries.keys())) {
            if (k.startsWith(`${uuid}::`)) this.entries.delete(k);
        }
    }

    private key(uuid: string, attr: TrackedAttr): string {
        return `${uuid}::${attr}`;
    }
}
