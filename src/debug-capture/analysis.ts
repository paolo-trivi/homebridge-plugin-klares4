import type { RawMessage } from './types';

export function analyzeMessages(rawMessages: RawMessage[]): Record<string, number> {
    const byType: Record<string, number> = {};
    rawMessages.forEach((msg) => {
        const command = typeof msg.parsed?.CMD === 'string' ? msg.parsed.CMD : undefined;
        if (command) {
            const key = `${msg.direction}:${command}`;
            byType[key] = (byType[key] || 0) + 1;
        }
    });
    return byType;
}

export function extractCommands(rawMessages: RawMessage[]): string[] {
    const commands = new Set<string>();
    rawMessages.forEach((msg) => {
        const command = typeof msg.parsed?.CMD === 'string' ? msg.parsed.CMD : undefined;
        if (command) {
            commands.add(command);
        }
    });
    return Array.from(commands).sort();
}

export function getUniquePayloadTypes(rawMessages: RawMessage[]): string[] {
    const types = new Set<string>();
    rawMessages.forEach((msg) => {
        const payloadType =
            typeof msg.parsed?.PAYLOAD_TYPE === 'string' ? msg.parsed.PAYLOAD_TYPE : undefined;
        if (payloadType) {
            types.add(payloadType);
        }
    });
    return Array.from(types).sort();
}

export function countByCommand(rawMessages: RawMessage[]): Record<string, number> {
    const counts: Record<string, number> = {};
    rawMessages.forEach((msg) => {
        const command = typeof msg.parsed?.CMD === 'string' ? msg.parsed.CMD : undefined;
        if (command) {
            counts[command] = (counts[command] || 0) + 1;
        }
    });
    return counts;
}
