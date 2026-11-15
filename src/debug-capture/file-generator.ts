import * as path from 'path';
import type { Logger } from 'homebridge';

import { writeFileAtomic, writeFileAtomicSync } from '../atomic-file';

import { PLUGIN_VERSION_RAW } from '../plugin-version';
import { analyzeMessages, countByCommand, extractCommands, getUniquePayloadTypes } from './analysis';
import type { DeviceSnapshot, RawMessage } from './types';

/** The file names the devices and the state of the alarm system: readable by its owner only. */
const FILE_OPTIONS = { mode: 0o600 };

const CONFIDENTIALITY_NOTICE =
    'CONFIDENTIAL. This file lists the names of your devices and the state of your alarm system '
    + '(which zones are open, whether it is armed, which scenarios exist). PINs, account data, panel '
    + 'serial numbers and the home position are masked, nothing else is. Do not attach it to a public '
    + 'issue or post it anywhere: send it privately, and only to someone you trust.';

export class DebugFileGenerator {
    constructor(
        private readonly log: Logger,
        private readonly storagePath: string,
    ) {}

    public generate(
        rawMessages: RawMessage[],
        deviceSnapshots: DeviceSnapshot[],
        captureDurationMs: number,
        options: { sync?: boolean; droppedMessages?: number } = {},
    ): void {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const filename = `klares4-debug-${timestamp}.json`;
            const filepath = path.join(this.storagePath, filename);
            const incomingMessages = rawMessages.filter((m) => m.direction === 'in').length;
            const outgoingMessages = rawMessages.filter((m) => m.direction === 'out').length;

            // Each frame is written once, as its (redacted) text: `parsed` is that text parsed.
            const frames = rawMessages.map(({ timestamp, direction, rawData }) => ({ timestamp, direction, rawData }));
            const debugData = {
                generated: new Date().toISOString(),
                version: PLUGIN_VERSION_RAW,
                captureInfo: {
                    duration: `${Math.max(1, Math.round(captureDurationMs / 1000))} seconds`,
                    totalRawMessages: rawMessages.length,
                    incomingMessages,
                    outgoingMessages,
                    deviceSnapshotsTaken: deviceSnapshots.length,
                    droppedMessages: options.droppedMessages ?? 0,
                },
                instructions: {
                    purpose: 'Traffic between the plugin and the Ksenia Lares4 panel, to diagnose entities that do not work',
                    privacy: CONFIDENTIALITY_NOTICE,
                    whatToLookFor: [
                        'Check rawMessages[] for the WebSocket traffic: each frame is the JSON text in rawData, written once',
                        'Compare deviceSnapshots[] to see how devices change over time (START and END always, INTERVAL only when something changed)',
                        'Look at messagesByType to understand what commands the central supports',
                        'Check commandsSeen[] for all commands that were actually used',
                        'PINs, account data, panel serial numbers and the home position are masked (***MASKED***)',
                        'captureInfo.droppedMessages counts frames left out when the buffer limit was reached',
                    ],
                },
                deviceSnapshots,
                rawMessages: frames,
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
            const reportWritten = (): void => {
                this.log.warn('[OK] COMPREHENSIVE DEBUG FILE GENERATED!');
                this.log.warn('[FILE] Location: ' + filepath);
                this.log.warn('[INFO] Contains:');
                this.log.warn(`   - ${frames.length} raw WebSocket messages`);
                this.log.warn(`   - ${debugData.deviceSnapshots.length} device snapshots`);
                this.log.warn(`   - ${debugData.statistics.devices} total devices`);
                this.log.warn('');
                this.log.warn('[PRIVACY] This file is confidential: it lists your devices and the state of your alarm system.');
                this.log.warn('[PRIVACY] PINs, account data, serial numbers and the home position are masked; nothing else is.');
                this.log.warn('[PRIVACY] Do not attach it to a public issue: send it privately, and only to someone you trust.');
                this.log.warn('[PRIVACY] It is readable by the Homebridge user only (mode 0600); delete it when you no longer need it.');
                this.log.warn('═══════════════════════════════════════════════════════════');
                this.log.warn('');
            };
            if (options.sync) {
                // Shutdown path: Homebridge exits shortly after, so the file must be on disk now.
                writeFileAtomicSync(filepath, serializedData, FILE_OPTIONS);
                reportWritten();
                return;
            }
            void writeFileAtomic(filepath, serializedData, FILE_OPTIONS)
                .then(reportWritten)
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
