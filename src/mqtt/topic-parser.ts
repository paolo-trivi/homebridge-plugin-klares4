export interface ParsedCommandTopic {
    deviceType: string;
    deviceIdentifier: string;
    /** The room level of `<prefix>/<room>/<type>/<id>/set`, absent on the direct form. */
    room?: string;
}

/**
 * Parses `<prefix>/<type>/<id>/set` and `<prefix>/<room>/<type>/<id>/set`.
 * Without `topicPrefix` the prefix is assumed to be two levels deep (the
 * `homebridge/klares4` default); with it, any prefix depth is supported.
 */
export function parseCommandTopic(topic: string, topicPrefix?: string): ParsedCommandTopic | null {
    if (topicPrefix !== undefined) {
        // Same raw prefix as the subscription filter `${topicPrefix}/+/+/set`.
        const prefix = `${topicPrefix}/`;
        if (!topic.startsWith(prefix)) return null;
        return parseCommandLevels(topic.slice(prefix.length).split('/'));
    }
    return parseCommandLevels(topic.split('/').slice(2));
}

/** The levels after the prefix: `<type>/<id>/set` or `<room>/<type>/<id>/set`. */
function parseCommandLevels(levels: string[]): ParsedCommandTopic | null {
    if (levels.at(-1) !== 'set') return null;
    if (levels.length === 3) {
        const [deviceType, deviceIdentifier] = levels;
        if (deviceType !== undefined && deviceIdentifier !== undefined) return { deviceType, deviceIdentifier };
    }
    if (levels.length === 4) {
        const [room, deviceType, deviceIdentifier] = levels;
        if (room !== undefined && deviceType !== undefined && deviceIdentifier !== undefined) return { room, deviceType, deviceIdentifier };
    }
    return null;
}

export { createDeviceSlug } from '../device-slug';

/**
 * Makes a free-text value (e.g. a room name) safe as a single topic level:
 * `+`, `#` and NUL are illegal in publish topics (MQTT-3.3.2-2, MQTT-4.7.3-2)
 * and `/` would add a level. Each is replaced by `_`; valid values are
 * returned unchanged.
 */
export function sanitizeTopicLevel(level: string): string {
    return level.replace(/[+#/\u0000]/g, '_');
}

export function buildStateTopic(
    topicPrefix: string,
    room: string | null,
    deviceType: string,
    deviceSlug: string,
): string {
    if (room) {
        return `${topicPrefix}/${room}/${deviceType}/${deviceSlug}/state`;
    }

    return `${topicPrefix}/${deviceType}/${deviceSlug}/state`;
}

/** `<prefix>/status`: retained availability of the bridge and of the panel connection. */
export function buildStatusTopic(topicPrefix: string): string {
    return `${topicPrefix}/status`;
}

/**
 * The prefix is published to verbatim, so it must be a valid topic name:
 * `+`, `#` and NUL are not allowed (MQTT-3.3.2-2, MQTT-4.7.3-2).
 */
export function isValidTopicPrefix(topicPrefix: string): boolean {
    return topicPrefix !== '' && !/[+#\u0000]/.test(topicPrefix);
}
