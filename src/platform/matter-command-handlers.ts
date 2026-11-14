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

import type { API, Logger, MatterAccessory } from 'homebridge';
import type { KseniaCover, KseniaLight } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';

type Handlers = NonNullable<MatterAccessory['handlers']>;

export interface CommandContext<T> {
    api: API;
    getWsClient: () => KseniaWebSocketClient | undefined;
    latest: () => T;
    log?: Logger;
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
 * The panel client, or a Matter Failure for the controller. Without a client
 * nothing reaches the panel, and an optional call (`client?.x()`) would
 * resolve: Homebridge would then apply the command to the Matter state and
 * report success (OnOffBehavior.js:37-64, LevelControlBehavior.js:20-49).
 */
export function requireWsClient(api: API, getWsClient: () => KseniaWebSocketClient | undefined): KseniaWebSocketClient {
    const client = getWsClient();
    if (client) return client;
    const message = 'Lares4 panel connection not available';
    const Failure = api.matter?.status?.Failure;
    throw Failure ? new Failure(message) : new Error(message);
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
    const client = (): KseniaWebSocketClient => requireWsClient(api, getWsClient);
    const handlers: Handlers = {
        onOff: {
            on: async () => { await client().switchLight(device.id, true); },
            off: async () => { await client().switchLight(device.id, false); },
            toggle: toggleRoutedToOnOff,
        },
    };
    if (!dimmable) return handlers;

    // Matter LevelControl commands without OnOff never switch a light on, and
    // matter.js ignores them while it is off (options.executeIfOff = false).
    // The panel cannot change a level without switching the output on, so
    // they send nothing either.
    handlers.levelControl = {
        moveToLevel: async (args: { level: number }) => {
            if (!latest().status?.on) return;
            // Without OnOff the command never switches the light off, even at the minimum level.
            await client().dimLight(device.id, levelToPercent(args.level));
        },
        moveToLevelWithOnOff: async (args: { level: number }) => {
            // matter.js turns OnOff off exactly when the target is the minimum level.
            const percent = args.level <= MIN_LEVEL ? 0 : levelToPercent(args.level);
            await client().dimLight(device.id, percent);
        },
        step: async (args: { stepMode: number; stepSize: number }) => {
            const status = latest().status;
            if (!status?.on) return;
            const current = percentToLevel(status.brightness ?? 100);
            const delta = args.stepMode === STEP_MODE_DOWN ? -args.stepSize : args.stepSize;
            const level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, current + delta));
            await client().dimLight(device.id, levelToPercent(level));
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

// WindowCovering MovementStatus (Matter spec §5.3.5.3).
const MOVEMENT_STOPPED = 0;
const MOVEMENT_OPENING = 1;
const MOVEMENT_CLOSING = 2;

/** Matter lift percent (0 = open, 10000 = closed) for a panel position (0 = closed, 100 = open). */
function liftPercent100ths(panelPosition: number): number {
    return Math.round((100 - Math.max(0, Math.min(100, panelPosition))) * 100);
}

/**
 * Homebridge runs the plugin handler and then matter.js's own command
 * (WindowCoveringBehavior.js:62-71), which, with no motor behind it, moves
 * `current` straight to the target: controllers would show the cover as
 * arrived while it has not moved yet. Once that command has committed, the
 * endpoint gets back the last position the panel reported, with the requested
 * target, so controllers see a movement in progress. matter.js derives the
 * movement status only when the target changes (WindowCoveringServer.js:144-151),
 * and here it already has, so the status goes with the positions; it returns
 * to stopped when `current` reaches the target (:162-169). Matter state only:
 * the device snapshot is not touched.
 */
function keepReportedPosition(device: KseniaCover, requested: number, ctx: CommandContext<KseniaCover>): void {
    setTimeout(() => {
        const position = ctx.latest().status?.position;
        const target = liftPercent100ths(requested);
        const attributes: Record<string, unknown> = { targetPositionLiftPercent100ths: target };
        if (Number.isFinite(position)) {
            const current = liftPercent100ths(position);
            const movement = current === target ? MOVEMENT_STOPPED : current < target ? MOVEMENT_CLOSING : MOVEMENT_OPENING;
            attributes.currentPositionLiftPercent100ths = current;
            attributes.operationalStatus = { global: movement, lift: movement, tilt: MOVEMENT_STOPPED };
        }
        ctx.api.matter?.updateAccessoryState(device.id, 'windowCovering', attributes)
            .catch((err: unknown) => {
                ctx.log?.debug(`[Matter] cover position refresh failed for ${device.id}: ${err instanceof Error ? err.message : String(err)}`);
            });
    }, 0);
}

export function buildCoverHandlers(device: KseniaCover, ctx: CommandContext<KseniaCover>): Handlers {
    const { api, getWsClient, latest } = ctx;
    const move = async (panelPercent: number): Promise<void> => {
        await requireWsClient(api, getWsClient).moveCover(device.id, panelPercent);
        keepReportedPosition(device, panelPercent, ctx);
    };
    return {
        windowCovering: {
            goToLiftPercentage: async (args: { liftPercent100thsValue: number }) => {
                await move(100 - Math.round(args.liftPercent100thsValue / 100));
            },
            upOrOpen: async () => { await move(100); },
            downOrClose: async () => { await move(0); },
            stopMotion: async () => {
                const status = latest().status;
                const target = status?.targetPosition ?? status?.position;
                if (status?.state === 'stopped' && target === status.position) return;
                // The panel offers no stop command, and moving to the last
                // reported position (one per second or so while travelling)
                // would send the cover back a little.
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
