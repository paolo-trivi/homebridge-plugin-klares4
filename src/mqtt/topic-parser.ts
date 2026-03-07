export interface ParsedCommandTopic {
    deviceType: string;
    deviceIdentifier: string;
}

export function parseCommandTopic(topic: string): ParsedCommandTopic | null {
    const topicParts = topic.split('/');

    if (topicParts.length === 5 && topicParts[4] === 'set') {
        return {
            deviceType: topicParts[2],
            deviceIdentifier: topicParts[3],
        };
    }

    if (topicParts.length === 6 && topicParts[5] === 'set') {
        return {
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
