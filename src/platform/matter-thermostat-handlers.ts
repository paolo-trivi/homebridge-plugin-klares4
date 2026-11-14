/**
 * Matter Thermostat attribute-change handler factory.
 *
 * Extracted from `matter-device-mapper.ts` so the mapper file stays under the
 * 350-line repo limit and the loop-prevention logic lives in one focused module.
 *
 * The handlers cooperate with `MatterThermostatEchoTracker` (registry-scoped) and
 * the Lares4 WS client to:
 *   - drop matter.js handler re-fires for our own state pushes (echo guard),
 *   - drop idempotent setpoint/mode changes (no-op when value already matches),
 *   - never forward cooling commands to heating-only zones,
 *   - swallow WS errors so a centrale timeout doesn't leave a matter.js reactor
 *     in an Unhandled-retry state, and re-publish the known state instead, so
 *     Matter does not keep showing a value the panel refused (F15).
 *
 * A Lares4 thermostat has a single target. It is the cooling setpoint in cool
 * mode on a cooling-capable zone and the heating setpoint otherwise (F21); a
 * change of the other ("non-active") setpoint — typically matter.js moving it
 * to keep the deadband — is never forwarded to the panel.
 *
 * Handlers are registered once per endpoint and outlive re-mappings, so they
 * read the latest device snapshot through `getDevice` rather than the copy
 * captured when the accessory was mapped.
 *
 * See `matter-thermostat-echo-tracker.ts` for the production failure mode this
 * module exists to prevent.
 */

import type { Logger } from 'homebridge';
import type { KseniaThermostat } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';
import {
    normalizeMatterSetpointC, matterSystemModeToKlares4Mode, domainModeToMatterSystemMode,
    DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C, DEFAULT_MIN_COOL_C, DEFAULT_MAX_COOL_C,
    DEFAULT_HEATING_SETPOINT_C, DEFAULT_COOLING_SETPOINT_C, isCoolingSetpointActive,
} from './matter-thermostat-mapper';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';

export interface ThermostatHandlerDeps {
    device: KseniaThermostat;
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

// SetpointRaiseLowerModeEnum (Matter spec §4.3.8.1)
const RAISE_LOWER_HEAT = 0;
const RAISE_LOWER_COOL = 1;

const targetOf = (d: KseniaThermostat): number | undefined => d.status?.targetTemperature ?? d.targetTemperature;
const modeOf = (d: KseniaThermostat): KseniaThermostat['mode'] | undefined => d.status?.mode ?? d.mode;

export function buildThermostatHandlers(deps: ThermostatHandlerDeps): Record<string, (args: any) => Promise<void>> {
    const { device, supportsCooling, log, getWsClient, tracker } = deps;
    const uuid = device.id;
    const fmt = (centi: number): string => (centi / 100).toFixed(2);
    const latest = (): KseniaThermostat => deps.getDevice?.() ?? device;
    const coolActive = (d: KseniaThermostat): boolean => isCoolingSetpointActive(supportsCooling, modeOf(d));
    const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

    const sendTemp = async (attr: SetpointAttr, label: string, value: number): Promise<void> => {
        tracker?.recordIntent(uuid, attr, Math.round(value * 100));
        try {
            await getWsClient()?.setThermostatTemperature(device.id, value);
        } catch (err) {
            failed(attr, `setThermostatTemperature(${label}) failed: ${errMsg(err)}`);
        }
    };

    const setpointChange = async (attr: SetpointAttr, centi: number): Promise<void> => {
        const cooling = attr === 'occupiedCoolingSetpoint';
        const current = latest();
        if (coolActive(current) !== cooling) {
            log.debug(`[Matter] ${device.name}: ${attr}=${fmt(centi)}°C not forwarded (not the active setpoint)`);
            return;
        }
        if (tracker?.isEcho(uuid, attr, centi)) {
            log.debug(`[Matter] internal Matter echo ignored: ${device.name} ${attr}=${fmt(centi)}°C`);
            return;
        }
        const { value } = cooling
            ? normalizeMatterSetpointC(centi, DEFAULT_MIN_COOL_C, DEFAULT_MAX_COOL_C)
            : normalizeMatterSetpointC(centi, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C);
        // Idempotency: if Lares4 already holds the requested setpoint, do not
        // enqueue a WRITE_CFG — re-sending it triggers a centrale broadcast
        // which re-fires this handler and (worst case) restarts the loop.
        const target = targetOf(current);
        if (typeof target === 'number' && Math.abs(target - value) < 0.05) {
            log.debug(`[Matter] idempotent Matter thermostat change ignored: ${device.name} ${attr} ${value}°C already current`);
            tracker?.recordIntent(uuid, attr, Math.round(value * 100));
            return;
        }
        log.debug(`[Matter] external Matter command accepted: ${device.name} ${attr} -> ${value}°C`);
        await sendTemp(attr, cooling ? 'cool' : 'heat', value);
    };

    return {
        setpointRaiseLower: (async (args: { mode: number; amount: number }) => {
            const current = latest();
            const cooling = coolActive(current);
            // Only the active setpoint exists on the panel; `Both` adjusts it too.
            if ((args.mode === RAISE_LOWER_HEAT && cooling) || (args.mode === RAISE_LOWER_COOL && !cooling)) {
                log.debug(`[Matter] ${device.name}: setpointRaiseLower mode=${args.mode} targets the non-active setpoint, not forwarded`);
                return;
            }
            const attr: SetpointAttr = cooling ? 'occupiedCoolingSetpoint' : 'occupiedHeatingSetpoint';
            const raw = (targetOf(current) ?? (cooling ? DEFAULT_COOLING_SETPOINT_C : DEFAULT_HEATING_SETPOINT_C)) + args.amount / 10;
            const { value } = cooling
                ? normalizeMatterSetpointC(raw * 100, DEFAULT_MIN_COOL_C, DEFAULT_MAX_COOL_C)
                : normalizeMatterSetpointC(raw * 100, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C);
            const centi = Math.round(value * 100);
            if (tracker?.isEcho(uuid, attr, centi)) {
                log.debug(`[Matter] internal Matter echo ignored: ${device.name} setpointRaiseLower -> ${fmt(centi)}°C`);
                return;
            }
            log.debug(`[Matter] external Matter command accepted: ${device.name} setpointRaiseLower -> ${value}°C`);
            await sendTemp(attr, 'raiseLower', value);
        }) as (args: any) => Promise<void>,

        occupiedHeatingSetpointChange: (async (args: { occupiedHeatingSetpoint: number }) => {
            await setpointChange('occupiedHeatingSetpoint', args.occupiedHeatingSetpoint);
        }) as (args: any) => Promise<void>,

        occupiedCoolingSetpointChange: (async (args: { occupiedCoolingSetpoint: number }) => {
            // Heating-only thermostats expose cooling attributes only because the
            // Homebridge bundled Thermostat device type still ships HEAT+COOL+AUTO
            // features. The cooling attribute is *state/read-only* for those zones:
            // any change must be treated as an echo and not forwarded as a command.
            if (!supportsCooling) {
                log.debug(`[Matter] ${device.name}: cooling setpoint change ignored (device does not support cooling)`);
                return;
            }
            await setpointChange('occupiedCoolingSetpoint', args.occupiedCoolingSetpoint);
        }) as (args: any) => Promise<void>,

        systemModeChange: (async (args: { systemMode: number }) => {
            const requestedMode = args.systemMode;
            if (tracker?.isEcho(uuid, 'systemMode', requestedMode)) {
                log.debug(`[Matter] internal Matter echo ignored: ${device.name} systemMode=${requestedMode}`);
                return;
            }
            const klares4Mode = matterSystemModeToKlares4Mode(requestedMode, supportsCooling);
            if (klares4Mode === null) {
                log.warn(`[Matter] ${device.name}: unsupported Matter systemMode ${requestedMode} ignored`);
                return;
            }
            tracker?.recordIntent(uuid, 'systemMode', domainModeToMatterSystemMode(klares4Mode));
            if (modeOf(latest()) === klares4Mode) {
                log.debug(`[Matter] idempotent Matter thermostat change ignored: ${device.name} mode=${klares4Mode} already current`);
                return;
            }
            log.debug(`[Matter] external Matter command accepted: ${device.name} systemMode ${requestedMode} -> ${klares4Mode}`);
            try {
                await getWsClient()?.setThermostatMode(device.id, klares4Mode);
            } catch (err) {
                failed('systemMode', `setThermostatMode failed: ${errMsg(err)}`);
            }
        }) as (args: any) => Promise<void>,
    };
}
