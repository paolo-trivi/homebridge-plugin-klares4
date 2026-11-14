import type { Logger } from 'homebridge';
import type { AccessoryHandler } from '../platform';
import type { KseniaDevice } from '../types';
import { createDeviceSlug } from '../mqtt/topic-parser';
import { logText } from '../mqtt/log-text';
import type { ThrottledWarnings } from './throttled-log';

export interface AccessoryIndexOptions {
    /** A device excluded in the config is never a command target, even with a handler restored from the cache. */
    isDeviceExcluded?: (device: KseniaDevice) => boolean;
    /** The room level of the device's topics (null: no room). */
    roomFor?: (deviceId: string) => string | null;
    /** True when `roomMapping` is on: a room level in a command topic must then match the device. */
    roomsEnforced?: () => boolean;
    /** Rate limits the warnings caused by what clients publish. */
    warnings?: ThrottledWarnings;
}

export class AccessoryIndexService {
    private readonly accessoryIndexById: Map<string, AccessoryHandler> = new Map();
    private readonly accessoryIndexBySlug: Map<string, AccessoryHandler[]> = new Map();
    private accessoryIndexSignature = '';

    constructor(
        private readonly platform: { readonly accessoryHandlers: ReadonlyMap<string, AccessoryHandler> },
        private readonly log: Logger,
        private readonly options: AccessoryIndexOptions = {},
    ) {}

    private warn(kind: string, message: string): void {
        if (this.options.warnings) this.options.warnings.warn(kind, message);
        else this.log.warn(message);
    }

    /**
     * Resolves `<type>/<identifier>` (device ID or name slug) to a handler.
     * With `roomMapping` on and a room level in the topic, the device must
     * belong to that room: a per-room ACL on the broker then really confines
     * what a client can command, and the room tells apart devices of
     * different rooms with the same name.
     */
    public findAccessoryByDevice(deviceType: string, deviceIdentifier: string, room?: string): AccessoryHandler | null {
        this.rebuildAccessoryIndexIfNeeded();
        const checkRoom = room !== undefined && (this.options.roomsEnforced?.() ?? false);
        const inRoom = (device: KseniaDevice): boolean => !checkRoom || (this.options.roomFor?.(device.id) ?? null) === room;
        const commandable = (handler: AccessoryHandler): boolean => {
            const device = this.getDeviceFromHandler(handler);
            return device?.type === deviceType && !(this.options.isDeviceExcluded?.(device) ?? false);
        };

        const handlerById = this.accessoryIndexById.get(deviceIdentifier);
        const deviceById = handlerById ? this.getDeviceFromHandler(handlerById) : undefined;
        if (handlerById && deviceById && commandable(handlerById)) {
            if (inRoom(deviceById)) return handlerById;
            this.warn('room', `MQTT: ${logText(deviceIdentifier)} is not in room ${logText(room ?? '')}; command ignored`);
            return null;
        }

        const matchingHandlers = (this.accessoryIndexBySlug.get(deviceIdentifier) ?? []).filter(commandable);
        const inRoomHandlers = matchingHandlers.filter((handler): boolean => {
            const device = this.getDeviceFromHandler(handler);
            return device !== undefined && inRoom(device);
        });

        if (inRoomHandlers.length === 1) {
            return inRoomHandlers[0];
        }
        if (inRoomHandlers.length > 1) {
            this.warn(
                'ambiguous',
                `MQTT: Ambiguous slug identifier ${logText(deviceIdentifier)} for type ${logText(deviceType)}. Use canonical device ID (e.g. light_1).`,
            );
        } else if (matchingHandlers.length > 0) {
            this.warn('room', `MQTT: ${logText(deviceIdentifier)} is not in room ${logText(room ?? '')}; command ignored`);
        }
        return null;
    }

    private getDeviceFromHandler(handler: AccessoryHandler): KseniaDevice | undefined {
        return 'device' in handler && handler.device ? handler.device : undefined;
    }

    private rebuildAccessoryIndexIfNeeded(): void {
        const currentSignature = this.getAccessoryIndexSignature();
        if (this.accessoryIndexSignature === currentSignature) {
            return;
        }

        this.accessoryIndexById.clear();
        this.accessoryIndexBySlug.clear();

        for (const [, handler] of this.platform.accessoryHandlers) {
            const device = this.getDeviceFromHandler(handler);
            if (!device) {
                continue;
            }
            this.accessoryIndexById.set(device.id, handler);
            const deviceSlug = createDeviceSlug(device.name);
            const existingHandlers = this.accessoryIndexBySlug.get(deviceSlug) ?? [];
            existingHandlers.push(handler);
            this.accessoryIndexBySlug.set(deviceSlug, existingHandlers);
        }

        this.accessoryIndexSignature = currentSignature;
    }

    private getAccessoryIndexSignature(): string {
        const parts: string[] = [];

        for (const [uuid, handler] of this.platform.accessoryHandlers) {
            const device = this.getDeviceFromHandler(handler);
            if (!device) {
                parts.push(`${uuid}:unknown`);
                continue;
            }

            parts.push(`${uuid}:${device.id}:${device.name}`);
        }

        return parts.join('|');
    }
}
