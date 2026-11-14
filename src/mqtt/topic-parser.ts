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
        const levels = topic.slice(prefix.length).split('/');
        if (levels.length === 3 && levels[2] === 'set') {
            return { deviceType: levels[0], deviceIdentifier: levels[1] };
        }
        if (levels.length === 4 && levels[3] === 'set') {
            return { room: levels[0], deviceType: levels[1], deviceIdentifier: levels[2] };
        }
        return null;
    }

    const topicParts = topic.split('/');

    if (topicParts.length === 5 && topicParts[4] === 'set') {
        return {
            deviceType: topicParts[2],
            deviceIdentifier: topicParts[3],
        };
    }

    if (topicParts.length === 6 && topicParts[5] === 'set') {
        return {
            room: topicParts[2],
            deviceType: topicParts[3],
            deviceIdentifier: topicParts[4],
        };
    }

    return null;
}

export function createDeviceSlug(deviceName: string): string {
    return deviceName
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[àáâãäå]/g, 'a')
        .replace(/[èéêë]/g, 'e')
        .replace(/[ìíîï]/g, 'i')
        .replace(/[òóôõö]/g, 'o')
        .replace(/[ùúûü]/g, 'u')
        .replace(/[ç]/g, 'c')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

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
