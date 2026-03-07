import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';

import { analyzeMessages, countByCommand, extractCommands, getUniquePayloadTypes } from './analysis';
import type { DeviceSnapshot, RawMessage } from './types';

export class DebugFileGenerator {
    constructor(
        private readonly log: Logger,
        private readonly storagePath: string,
    ) {}

    public generate(
        rawMessages: RawMessage[],
        deviceSnapshots: DeviceSnapshot[],
        captureDurationMs: number,
    ): void {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const filename = `klares4-debug-${timestamp}.json`;
            const filepath = path.join(this.storagePath, filename);
            const incomingMessages = rawMessages.filter((m) => m.direction === 'in').length;
            const outgoingMessages = rawMessages.filter((m) => m.direction === 'out').length;

            const debugData = {
                generated: new Date().toISOString(),
                version: '1.1.9-beta0',
                captureInfo: {
                    duration: `${Math.max(1, Math.round(captureDurationMs / 1000))} seconds`,
                    totalRawMessages: rawMessages.length,
                    incomingMessages,
                    outgoingMessages,
                    deviceSnapshotsTaken: deviceSnapshots.length,
                },
                instructions: {
                    purpose: 'This file contains EVERYTHING needed to diagnose non-working entities',
                    whatToLookFor: [
                        'Check rawMessages[] for complete WebSocket traffic',
                        'Compare deviceSnapshots[] to see how devices change over time',
                        'Look at messagesByType to understand what commands the central supports',
                        'Check commandsSeen[] for all commands that were actually used',
                        'PIN codes are already masked for security',
                    ],
                },
                deviceSnapshots,
                rawMessages,
                analysis: {
                    messagesByType: analyzeMessages(rawMessages),
                    commandsSeen: extractCommands(rawMessages),
                    uniquePayloadTypes: getUniquePayloadTypes(rawMessages),
                },
                statistics: {
                    messages: {
                        total: rawMessages.length,
                        incoming: incomingMessages,
                        outgoing: outgoingMessages,
                        byCommand: countByCommand(rawMessages),
                    },
                    devices:
                        deviceSnapshots.length > 0
                            ? deviceSnapshots[deviceSnapshots.length - 1].deviceCount
                            : 0,
                },
            };

            const serializedData = JSON.stringify(debugData, null, 2);
            void fs.promises
                .writeFile(filepath, serializedData, 'utf8')
                .then((): void => {
                    this.log.warn('[OK] COMPREHENSIVE DEBUG FILE GENERATED!');
                    this.log.warn('[FILE] Location: ' + filepath);
                    this.log.warn('[INFO] Contains:');
                    this.log.warn(`   - ${debugData.rawMessages.length} raw WebSocket messages`);
                    this.log.warn(`   - ${debugData.deviceSnapshots.length} device snapshots`);
                    this.log.warn(`   - ${debugData.statistics.devices} total devices`);
                    this.log.warn('');
                    this.log.warn('[SHARE] Share this file for support - PINs are already masked!');
                    this.log.warn('═══════════════════════════════════════════════════════════');
                    this.log.warn('');
                })
                .catch((error: unknown): void => {
                    this.log.error(
                        'Error generating debug file:',
                        error instanceof Error ? error.message : String(error),
                    );
                });
        } catch (error: unknown) {
            this.log.error(
                'Error generating debug file:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
