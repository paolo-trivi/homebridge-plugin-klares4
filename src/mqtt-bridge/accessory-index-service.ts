import type { Logger } from 'homebridge';
import type { AccessoryHandler, Lares4Platform } from '../platform';
import type { KseniaDevice } from '../types';
import { createDeviceSlug } from '../mqtt/topic-parser';

export class AccessoryIndexService {
    private readonly accessoryIndexById: Map<string, AccessoryHandler> = new Map();
    private readonly accessoryIndexBySlug: Map<string, AccessoryHandler[]> = new Map();
    private accessoryIndexSignature = '';

    constructor(
        private readonly platform: Lares4Platform,
        private readonly log: Logger,
    ) {}

    public findAccessoryByDevice(deviceType: string, deviceIdentifier: string): AccessoryHandler | null {
        this.rebuildAccessoryIndexIfNeeded();

        const handlerById = this.accessoryIndexById.get(deviceIdentifier);
        if (handlerById) {
            const device = this.getDeviceFromHandler(handlerById);
            if (device?.type === deviceType) {
                return handlerById;
            }
        }

        const handlersBySlug = this.accessoryIndexBySlug.get(deviceIdentifier);
        if (handlersBySlug && handlersBySlug.length > 0) {
            const matchingHandlers = handlersBySlug.filter((handler): boolean => {
                const device = this.getDeviceFromHandler(handler);
                return device?.type === deviceType;
            });

            if (matchingHandlers.length === 1) {
                return matchingHandlers[0];
            }

            if (matchingHandlers.length > 1) {
                this.log.warn(
                    `MQTT: Ambiguous slug identifier "${deviceIdentifier}" for type "${deviceType}". Use canonical device ID (e.g. light_1).`,
                );
            }
        }

        return null;
    }

    private getDeviceFromHandler(handler: AccessoryHandler): KseniaDevice | undefined {
        if ('device' in handler && handler.device) {
            return handler.device as KseniaDevice;
        }
        return undefined;
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
