/**
 * Matter command handlers for lights, covers and momentary outputs.
 *
 * Homebridge 2.4 routes every command its cluster servers implement through
 * `BehaviorRegistry.executeHandler`, which throws "No handler registered" when
 * the plugin supplied none: a mandatory command without a handler always
 * failed. Each handler here either drives the panel faithfully or refuses the
 * command on purpose with UnsupportedCommand.
 *
 * Handlers are registered once per endpoint, so they read the latest device
 * snapshot through `latest()` instead of the copy captured at mapping time.
 */

import type { API, MatterAccessory } from 'homebridge';
import type { KseniaCover, KseniaLight } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';

type Handlers = NonNullable<MatterAccessory['handlers']>;

interface CommandContext<T> {
    api: API;
    getWsClient: () => KseniaWebSocketClient | undefined;
    latest: () => T;
}

// Matter spec: Status.UnsupportedCommand. Homebridge ships no named class for it.
const STATUS_UNSUPPORTED_COMMAND = 0x81;
const MIN_LEVEL = 1;
const MAX_LEVEL = 254;
// LevelControl StepModeEnum (Matter spec §1.6.6.2)
const STEP_MODE_DOWN = 1;

function unsupportedCommand(api: API, message: string): Error {
    const status = api.matter?.status;
    return status?.MatterProtocolError
        ? new status.MatterProtocolError(message, STATUS_UNSUPPORTED_COMMAND)
        : new Error(message);
}

/**
 * HomebridgeOnOffServer.toggle() runs this handler and then super.toggle(),
 * whose this.on()/this.off() dispatch back to the Homebridge overrides and so
 * run the 'on'/'off' handler, which drives the panel. Acting here as well
 * would send the command twice (for a gate: open, then close).
 */
const toggleRoutedToOnOff = async (): Promise<void> => undefined;

/** Matter level (1..254) to a panel percentage that never reads as "off". */
function levelToPercent(level: number): number {
    return Math.max(1, Math.min(100, Math.round((level / MAX_LEVEL) * 100)));
}

function percentToLevel(percent: number): number {
    return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round((percent / 100) * MAX_LEVEL)));
}

export function buildLightHandlers(device: KseniaLight, dimmable: boolean, ctx: CommandContext<KseniaLight>): Handlers {
    const { api, getWsClient, latest } = ctx;
    const handlers: Handlers = {
        onOff: {
            on: async () => { await getWsClient()?.switchLight(device.id, true); },
            off: async () => { await getWsClient()?.switchLight(device.id, false); },
            toggle: toggleRoutedToOnOff,
        },
    };
    if (!dimmable) return handlers;

    handlers.levelControl = {
        moveToLevel: async (args: { level: number }) => {
            // Without OnOff the command never switches the light off, even at the minimum level.
            await getWsClient()?.dimLight(device.id, levelToPercent(args.level));
        },
        moveToLevelWithOnOff: async (args: { level: number }) => {
            // matter.js turns OnOff off exactly when the target is the minimum level.
            const percent = args.level <= MIN_LEVEL ? 0 : levelToPercent(args.level);
            await getWsClient()?.dimLight(device.id, percent);
        },
        step: async (args: { stepMode: number; stepSize: number }) => {
            const status = latest().status;
            // The panel cannot change a level without switching the output on.
            if (!status?.on) return;
            const current = percentToLevel(status.brightness ?? 100);
            const delta = args.stepMode === STEP_MODE_DOWN ? -args.stepSize : args.stepSize;
            const level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, current + delta));
            await getWsClient()?.dimLight(device.id, levelToPercent(level));
        },
        move: async () => {
            // A continuous move at a rate until Stop has no panel equivalent:
            // the output only takes a target level.
            throw unsupportedCommand(api, 'Lares4 dimmers cannot move continuously');
        },
        // Nothing moves on the panel side: every level command lands at once.
        stop: async () => undefined,
    };
    return handlers;
}

export function buildCoverHandlers(device: KseniaCover, ctx: CommandContext<KseniaCover>): Handlers {
    const { api, getWsClient, latest } = ctx;
    return {
        windowCovering: {
            goToLiftPercentage: async (args: { liftPercent100thsValue: number }) => {
                const targetPct = 100 - Math.round(args.liftPercent100thsValue / 100);
                await getWsClient()?.moveCover(device.id, targetPct);
            },
            upOrOpen: async () => { await getWsClient()?.moveCover(device.id, 100); },
            downOrClose: async () => { await getWsClient()?.moveCover(device.id, 0); },
            stopMotion: async () => {
                const status = latest().status;
                const target = status?.targetPosition ?? status?.position;
                if (status?.state === 'stopped' && target === status.position) return;
                // The panel reports POS only when a movement starts and ends and
                // offers no stop command: moving to the last reported position
                // would send the cover back to where it started.
                throw unsupportedCommand(api, 'Lares4 covers cannot be stopped mid-travel from Matter');
            },
        },
    };
}

export function buildMomentaryHandlers(trigger: () => Promise<void>): Handlers {
    return {
        onOff: {
            on: trigger,
            off: async () => { /* momentary trigger — no-op */ },
            toggle: toggleRoutedToOnOff,
        },
    };
}
