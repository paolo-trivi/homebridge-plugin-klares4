import type { Logger } from 'homebridge';

import type { RoomMappingConfig } from '../types';
import { sanitizeTopicLevel } from '../mqtt/topic-parser';

/** The room level of a device's topics, from `roomMapping` (null when off or unmapped). */
export class RoomResolver {
    /** Room names already reported as unsafe for a topic level (warn once each). */
    private readonly warnedRoomNames = new Set<string>();

    constructor(
        private readonly getRoomMapping: () => RoomMappingConfig | undefined,
        private readonly log: Logger,
    ) {}

    public get enabled(): boolean {
        return this.getRoomMapping()?.enabled === true;
    }

    public roomFor(deviceId: string): string | null {
        const mapping = this.getRoomMapping();
        if (!mapping?.enabled) return null;
        for (const room of mapping.rooms ?? []) {
            if (room.devices?.some((device) => device.deviceId === deviceId)) {
                return this.toTopicRoom(room.roomName);
            }
        }
        return null;
    }

    private toTopicRoom(roomName: string): string {
        const safeRoom = sanitizeTopicLevel(roomName);
        if (safeRoom !== roomName && !this.warnedRoomNames.has(roomName)) {
            this.warnedRoomNames.add(roomName);
            this.log.warn(
                `MQTT: Room name "${roomName}" contains '+', '#' or '/', which are not allowed in a topic level; ` +
                    `publishing under "${safeRoom}" instead.`,
            );
        }
        return safeRoom;
    }
}
