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
 *     in an Unhandled-retry state.
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
} from './matter-thermostat-mapper';
import type { MatterThermostatEchoTracker } from './matter-thermostat-echo-tracker';

export interface ThermostatHandlerDeps {
    device: KseniaThermostat;
    supportsCooling: boolean;
    log: Logger;
    getWsClient: () => KseniaWebSocketClient | undefined;
    tracker?: MatterThermostatEchoTracker;
}

export function buildThermostatHandlers(deps: ThermostatHandlerDeps): Record<string, (args: any) => Promise<void>> {
    const { device, supportsCooling, log, getWsClient, tracker } = deps;
    const uuid = device.id;
    const fmt = (centi: number): string => (centi / 100).toFixed(2);

    const sendTemp = async (label: string, value: number): Promise<void> => {
        try {
            await getWsClient()?.setThermostatTemperature(device.id, value);
        } catch (err) {
            // Swallow timeouts/errors: re-throwing causes matter.js to mark the
            // handler "Unhandled" and many controllers respond by re-issuing the
            // command — feeding the very loop this guard exists to prevent.
            log.warn(`[Matter] ${device.name}: setThermostatTemperature(${label}) failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    return {
        setpointRaiseLower: (async (args: { mode: number; amount: number }) => {
            const delta = args.amount / 10;
            const raw = (device.targetTemperature ?? 21) + delta;
            const { value } = normalizeMatterSetpointC(raw * 100, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C);
            const centi = Math.round(value * 100);
            if (tracker?.isEcho(uuid, 'occupiedHeatingSetpoint', centi)) {
                log.debug(`[Matter] internal Matter echo ignored: ${device.name} setpointRaiseLower -> heat ${fmt(centi)}°C`);
                return;
            }
            tracker?.recordIntent(uuid, 'occupiedHeatingSetpoint', centi);
            log.debug(`[Matter] external Matter command accepted: ${device.name} setpointRaiseLower -> ${value}°C`);
            await sendTemp('raiseLower', value);
        }) as (args: any) => Promise<void>,

        occupiedHeatingSetpointChange: (async (args: { occupiedHeatingSetpoint: number }) => {
            const centi = args.occupiedHeatingSetpoint;
            if (tracker?.isEcho(uuid, 'occupiedHeatingSetpoint', centi)) {
                log.debug(`[Matter] internal Matter echo ignored: ${device.name} occupiedHeatingSetpoint=${fmt(centi)}°C`);
                return;
            }
            const { value } = normalizeMatterSetpointC(centi, DEFAULT_MIN_HEAT_C, DEFAULT_MAX_HEAT_C);
            // Idempotency: if Lares4 already holds the requested setpoint, do not
            // enqueue a WRITE_CFG — re-sending it triggers a centrale broadcast
            // which re-fires this handler and (worst case) restarts the loop.
            if (typeof device.targetTemperature === 'number' && Math.abs(device.targetTemperature - value) < 0.05) {
                log.debug(`[Matter] idempotent Matter thermostat change ignored: ${device.name} heat ${value}°C already current`);
                tracker?.recordIntent(uuid, 'occupiedHeatingSetpoint', Math.round(value * 100));
                return;
            }
            tracker?.recordIntent(uuid, 'occupiedHeatingSetpoint', Math.round(value * 100));
            log.debug(`[Matter] external Matter command accepted: ${device.name} occupiedHeatingSetpoint -> ${value}°C`);
            await sendTemp('heat', value);
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
            const centi = args.occupiedCoolingSetpoint;
            if (tracker?.isEcho(uuid, 'occupiedCoolingSetpoint', centi)) {
                log.debug(`[Matter] internal Matter echo ignored: ${device.name} occupiedCoolingSetpoint=${fmt(centi)}°C`);
                return;
            }
            const { value } = normalizeMatterSetpointC(centi, DEFAULT_MIN_COOL_C, DEFAULT_MAX_COOL_C);
            tracker?.recordIntent(uuid, 'occupiedCoolingSetpoint', Math.round(value * 100));
            log.debug(`[Matter] external Matter command accepted: ${device.name} occupiedCoolingSetpoint -> ${value}°C`);
            await sendTemp('cool', value);
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
            if (device.mode === klares4Mode) {
                log.debug(`[Matter] idempotent Matter thermostat change ignored: ${device.name} mode=${klares4Mode} already current`);
                tracker?.recordIntent(uuid, 'systemMode', domainModeToMatterSystemMode(klares4Mode));
                return;
            }
            tracker?.recordIntent(uuid, 'systemMode', domainModeToMatterSystemMode(klares4Mode));
            log.debug(`[Matter] external Matter command accepted: ${device.name} systemMode ${requestedMode} -> ${klares4Mode}`);
            try {
                await getWsClient()?.setThermostatMode(device.id, klares4Mode);
            } catch (err) {
                log.warn(`[Matter] ${device.name}: setThermostatMode failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }) as (args: any) => Promise<void>,
    };
}
