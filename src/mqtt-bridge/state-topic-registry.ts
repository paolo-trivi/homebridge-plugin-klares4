import type { Logger } from 'homebridge';

import { buildStateTopic, sanitizeTopicLevel } from '../mqtt/topic-parser';

export interface StateTopicRequest {
    deviceId: string;
    deviceType: string;
    room: string | null;
    slug: string;
}

interface Entry extends StateTopicRequest {
    natural: string;
}

/**
 * Decides the state topic of each device. A device keeps the name-based
 * topic (`<type>/<slug>`) unless another device has the same one or its name
 * gives an empty slug: then it publishes under its device ID instead
 * (`<type>/<id>`), so two devices never share a retained topic. Devices that
 * do not collide keep their topic. The decision depends only on the set of
 * devices known, not on the order they were published in.
 */
export class StateTopicRegistry {
    private readonly entries = new Map<string, Entry>();
    private assigned = new Map<string, string>();
    private readonly warned = new Set<string>();

    constructor(
        private readonly topicPrefix: string,
        private readonly log: Logger,
    ) {}

    /**
     * Records the device and returns its topic, plus the other devices whose
     * topic changed because of it (they must be republished).
     */
    public resolve(request: StateTopicRequest): { topic: string; moved: string[] } {
        const natural = buildStateTopic(this.topicPrefix, request.room, request.deviceType, request.slug);
        const previous = this.entries.get(request.deviceId);
        const current = this.assigned.get(request.deviceId);
        if (previous && previous.natural === natural && previous.deviceType === request.deviceType && current) {
            return { topic: current, moved: [] };
        }
        this.entries.set(request.deviceId, { ...request, natural });
        const before = this.assigned;
        this.assigned = this.assignAll();
        const moved = [...this.assigned]
            .filter(([deviceId, topic]) => deviceId !== request.deviceId && before.get(deviceId) !== topic)
            .map(([deviceId]) => deviceId);
        return { topic: this.assigned.get(request.deviceId) ?? natural, moved };
    }

    private assignAll(): Map<string, string> {
        const byNatural = new Map<string, Entry[]>();
        for (const entry of this.entries.values()) {
            const group = byNatural.get(entry.natural) ?? [];
            group.push(entry);
            byNatural.set(entry.natural, group);
        }
        const result = new Map<string, string>();
        const fallback: Entry[] = [];
        for (const [natural, group] of byNatural) {
            if (group.length === 1 && group[0].slug !== '') {
                result.set(group[0].deviceId, natural);
                continue;
            }
            fallback.push(...group);
            this.warnCollision(natural, group);
        }
        const taken = new Set(result.values());
        fallback.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
        for (const entry of fallback) {
            const level = sanitizeTopicLevel(entry.deviceId);
            let topic = buildStateTopic(this.topicPrefix, entry.room, entry.deviceType, level);
            // A device named like another device's ID: keep the named one, number this one.
            for (let n = 2; taken.has(topic); n += 1) {
                topic = buildStateTopic(this.topicPrefix, entry.room, entry.deviceType, `${level}_${n}`);
            }
            taken.add(topic);
            result.set(entry.deviceId, topic);
        }
        return result;
    }

    private warnCollision(natural: string, group: Entry[]): void {
        const key = `${natural}|${group.map((entry) => entry.deviceId).sort().join(',')}`;
        if (this.warned.has(key)) return;
        this.warned.add(key);
        const ids = group.map((entry) => entry.deviceId).sort().join(', ');
        const why = group.length === 1
            ? `the name of ${ids} has no letters or digits for a topic`
            : `${ids} have names that give the same state topic ${natural}`;
        this.log.warn(
            `MQTT: ${why}; publishing under the device ID instead (e.g. .../${group[0].deviceType}/${group[0].deviceId}/state). ` +
                'Give each device a distinct name (customNames) to get a name-based topic.',
        );
    }
}
