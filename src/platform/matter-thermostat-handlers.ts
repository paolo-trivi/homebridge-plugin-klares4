/**
 * Matter Thermostat attribute-change handler factory.
 *
 * Extracted from `matter-device-mapper.ts` so the mapper file stays under the
 * 350-line repo limit and the loop-prevention logic lives in one focused module.
 *
 * The handlers cooperate with `MatterThermostatEchoTracker` (registry-scoped) and
 * the Lares4 WS client to:
 *   - drop matter.js handler re-fires for our own state pushes (echo guard),
 *   - drop idempotent setpoint/mode changes, compared with the value the panel
 *     last acknowledged when the realtime has not caught up with it yet (TH-08),
 *   - forward only what the output's role allows: a heating output never takes
 *     Cool or Auto, a cooling output never Heat or Auto, and neither takes a
 *     setpoint or a mode while the program runs in the other season (TH-05),
 *   - swallow WS errors so a panel timeout doesn't leave a matter.js reactor
 *     in an Unhandled-retry state, and re-publish the known state instead, so
 *     Matter does not keep showing a value the panel refused (F15). A refused
 *     command, a missing client included, is reported the same way.
 *
 * A Lares4 thermostat has a single target. On an output that does both it is
 * the cooling setpoint in cool mode and the heating setpoint otherwise (F21); a
 * change of the other ("non-active") setpoint — typically matter.js moving it
 * to keep the deadband — is never forwarded to the panel.
 *
 * Handlers are registered once per endpoint and outlive re-mappings, so they
 * read the latest device snapshot (role included) through `getDevice` rather
 * than the copy captured when the accessory was mapped.
 *
 * See `matter-thermostat-echo-tracker.ts` for the production failure mode this
 * module exists to prevent.
 */

import type { Logger, MatterClusterHandlers } from 'homebridge';
import type { KseniaThermostat, ThermostatOutputRole } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import {
    normalizeMatterSetpointC, matterSystemModeForRole, isCoolingSetpointActiveForRole,
    DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C, DEFAULT_MIN_COOL_C, DEFAULT_MAX_COOL_C,
    DEFAULT_HEATING_SETPOINT_C, DEFAULT_COOLING_SETPOINT_C,
} from './matter-thermostat-mapper';
import { isRoleInSeason, thermostatRole } from './matter-thermostat-role';
import type { MatterThermostatEchoTracker, RealtimeObservation } from './matter-thermostat-echo-tracker';
import { toErrorMessage } from '../errors';

export interface ThermostatHandlerDeps {
    device: KseniaThermostat;
    /** Kept for callers; the handlers derive the capability from the latest snapshot's role. */
    supportsCooling: boolean;
    log: Logger;
    getWsClient: () => KseniaWebSocketClient | undefined;
    tracker?: MatterThermostatEchoTracker;
    /** Latest snapshot of the device; defaults to the mapped `device`. */
    getDevice?: () => KseniaThermostat;
    /** Re-publish the known state after a command the panel did not apply. */
    republish?: () => void;
}

type SetpointAttr = 'occupiedHeatingSetpoint' | 'occupiedCoolingSetpoint';
type Mode = KseniaThermostat['mode'];

// SetpointRaiseLowerModeEnum (Matter spec §4.3.8.1)
const RAISE_LOWER_HEAT = 0;
const RAISE_LOWER_COOL = 1;

const OTHER_SEASON = 'the program is running in the other season, and this output is not the one it drives';

export function buildThermostatHandlers(deps: ThermostatHandlerDeps): MatterClusterHandlers {
    const { device, log, getWsClient, tracker } = deps;
    const uuid = device.id;
    const fmt = (centi: number): string => (centi / 100).toFixed(2);
    const latest = (): KseniaThermostat => deps.getDevice?.() ?? device;
    const observationOf = (d: KseniaThermostat): RealtimeObservation => ({ seq: d.status?.observedSeq, at: d.status?.observedAt });
    const modeOf = (d: KseniaThermostat): Mode | undefined => {
        const observed = d.status?.mode ?? d.mode;
        return tracker ? tracker.effectiveMode(uuid, observed, observationOf(d)) : observed;
    };
    const targetOf = (d: KseniaThermostat): number | undefined => {
        const observed = d.status?.targetTemperature ?? d.targetTemperature;
        return tracker ? tracker.effectiveTarget(uuid, observed, observationOf(d)) : observed;
    };
    const coolActive = (role: ThermostatOutputRole, d: KseniaThermostat): boolean => isCoolingSetpointActiveForRole(role, modeOf(d));
    /** The role the live endpoint was registered for, else the device's. */
    const roleOf = (d: KseniaThermostat): ThermostatOutputRole => tracker?.registeredRole(uuid) ?? thermostatRole(d);
    const client = (): KseniaWebSocketClient => {
        const ws = getWsClient();
        if (!ws) throw new Error('no connection to the panel');
        return ws;
    };

    const failed = (attr: SetpointAttr | 'systemMode', message: string): void => {
        // Swallow timeouts/errors: re-throwing causes matter.js to mark the
        // handler "Unhandled" and many controllers respond by re-issuing the
        // command — feeding the very loop this guard exists to prevent. The
        // intent is dropped so a retry of the same value is not taken for an
        // echo (F33), and the known state goes back to Matter (F15).
        log.warn(`[Matter] ${device.name}: ${message}`);
        tracker?.consume(uuid, attr);
        deps.republish?.();
    };

    /**
     * Records an ACK in the tracker's ledger only when the client did not
     * apply it to the device state itself (`status.acknowledged` unchanged).
     * When it did, the state already says what the ACK means (in AUTO or OFF
     * a setpoint is not the live target), and the ledger must not override it.
     */
    const ackedByClient = (before: unknown): boolean => latest().status?.acknowledged !== before;

    const sendTemp = async (attr: SetpointAttr, label: string, value: number): Promise<void> => {
        try {
            const before = latest().status?.acknowledged;
            await client().setThermostatTemperature(device.id, value);
            if (!ackedByClient(before)) tracker?.recordConfirmed(uuid, 'target', value, latest().status?.observedSeq);
        } catch (err) {
            failed(attr, `setThermostatTemperature(${label}) failed: ${toErrorMessage(err)}`);
        }
    };

    const normalize = (cooling: boolean, centi: number): number => (cooling
        ? normalizeMatterSetpointC(centi, DEFAULT_MIN_COOL_C, DEFAULT_MAX_COOL_C)
        : normalizeMatterSetpointC(centi, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C)).value;

    const setpointChange = async (attr: SetpointAttr, centi: number): Promise<void> => {
        const cooling = attr === 'occupiedCoolingSetpoint';
        const current = latest();
        const role = roleOf(current);
        if (coolActive(role, current) !== cooling) {
            log.debug(`[Matter] ${device.name}: ${attr}=${fmt(centi)}°C not forwarded (not the active setpoint)`);
            return;
        }
        if (tracker?.isEcho(uuid, attr, centi)) {
            log.debug(`[Matter] internal Matter echo ignored: ${device.name} ${attr}=${fmt(centi)}°C`);
            return;
        }
        if (!isRoleInSeason(role, current)) {
            failed(attr, `${attr} ${fmt(centi)}°C not forwarded: ${OTHER_SEASON}`);
            return;
        }
        const value = normalize(cooling, centi);
        // Idempotency: if Lares4 already holds the requested setpoint, do not
        // enqueue a WRITE_CFG — re-sending it triggers a panel broadcast
        // which re-fires this handler and (worst case) restarts the loop.
        const target = targetOf(current);
        if (typeof target === 'number' && Math.abs(target - value) < 0.05) {
            log.debug(`[Matter] idempotent Matter thermostat change ignored: ${device.name} ${attr} ${value}°C already current`);
            return;
        }
        log.debug(`[Matter] external Matter command accepted: ${device.name} ${attr} -> ${value}°C`);
        await sendTemp(attr, cooling ? 'cool' : 'heat', value);
    };

    const setpointRaiseLower = async (args: { mode: number; amount: number }): Promise<void> => {
        const current = latest();
        const role = roleOf(current);
        const cooling = coolActive(role, current);
        // Only the active setpoint exists on the panel; `Both` adjusts it too.
        if ((args.mode === RAISE_LOWER_HEAT && cooling) || (args.mode === RAISE_LOWER_COOL && !cooling)) {
            log.debug(`[Matter] ${device.name}: setpointRaiseLower mode=${args.mode} targets the non-active setpoint, not forwarded`);
            return;
        }
        const attr: SetpointAttr = cooling ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint';
        if (!isRoleInSeason(role, current)) {
            failed(attr, `setpointRaiseLower not forwarded: ${OTHER_SEASON}`);
            return;
        }
        // The base is the last acknowledged target when the realtime has not caught up (F33).
        const raw = (targetOf(current) ?? (cooling ? DEFAULT_COOLING_SETPOINT_C : DEFAULT_HEATING_SETPOINT_C)) + args.amount / 10;
        const value = normalize(cooling, raw * 100);
        const centi = Math.round(value * 100);
        if (tracker?.isEcho(uuid, attr, centi)) {
            log.debug(`[Matter] internal Matter echo ignored: ${device.name} setpointRaiseLower -> ${fmt(centi)}°C`);
            return;
        }
        log.debug(`[Matter] external Matter command accepted: ${device.name} setpointRaiseLower -> ${value}°C`);
        await sendTemp(attr, 'raiseLower', value);
    };

    const systemModeChange = async (args: { systemMode: number }): Promise<void> => {
        const requestedMode = args.systemMode;
        if (tracker?.isEcho(uuid, 'systemMode', requestedMode)) {
            log.debug(`[Matter] internal Matter echo ignored: ${device.name} systemMode=${requestedMode}`);
            return;
        }
        const current = latest();
        const role = roleOf(current);
        const klares4Mode = matterSystemModeForRole(requestedMode, role);
        if (klares4Mode === null) {
            // matter.js already refuses most of these by conformance; this covers
            // the rest (TH-15) so the controller sees the value go back.
            failed('systemMode', `systemMode ${requestedMode} is not supported by this ${role} output`);
            return;
        }
        if (!isRoleInSeason(role, current)) {
            if (klares4Mode === 'off') {
                // The endpoint already shows Off; forwarding it would stop the other output.
                log.debug(`[Matter] ${device.name}: systemMode Off not forwarded: ${OTHER_SEASON}`);
                return;
            }
            failed('systemMode', `systemMode ${klares4Mode} not forwarded: ${OTHER_SEASON}; switching it here would change the season of the whole program`);
            return;
        }
        if (modeOf(current) === klares4Mode) {
            log.debug(`[Matter] idempotent Matter thermostat change ignored: ${device.name} mode=${klares4Mode} already current`);
            return;
        }
        log.debug(`[Matter] external Matter command accepted: ${device.name} systemMode ${requestedMode} -> ${klares4Mode}`);
        try {
            const before = latest().status?.acknowledged;
            await client().setThermostatMode(device.id, klares4Mode);
            if (!ackedByClient(before)) tracker?.recordConfirmed(uuid, 'mode', klares4Mode, latest().status?.observedSeq);
        } catch (err) {
            failed('systemMode', `setThermostatMode failed: ${toErrorMessage(err)}`);
        }
    };

    return {
        setpointRaiseLower,
        occupiedHeatingSetpointChange: async (args: { occupiedHeatingSetpoint: number }) => {
            await setpointChange('occupiedHeatingSetpoint', args.occupiedHeatingSetpoint);
        },
        occupiedCoolingSetpointChange: async (args: { occupiedCoolingSetpoint: number }) => {
            // Only the legacy payload declares a cooling setpoint on a heating
            // output; there it is read-only state and never a command.
            if (roleOf(latest()) === 'heating') {
                log.debug(`[Matter] ${device.name}: cooling setpoint change ignored (heating output)`);
                return;
            }
            await setpointChange('occupiedCoolingSetpoint', args.occupiedCoolingSetpoint);
        },
        systemModeChange,
    };
}
