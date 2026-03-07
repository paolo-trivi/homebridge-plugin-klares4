import type { Logger } from 'homebridge';

import { DebugFileGenerator } from './file-generator';
import { captureRawMessage } from './raw-message-capture';
import type { DeviceSnapshot, RawMessage } from './types';
import type { KseniaWebSocketClient, RawMessageDirection } from '../websocket-client';

export class DebugCaptureManager {
    private rawMessages: RawMessage[] = [];
    private isCapturing = false;
    private captureTimer?: NodeJS.Timeout;
    private snapshotInterval?: NodeJS.Timeout;
    private deviceSnapshots: DeviceSnapshot[] = [];
    private rawMessageUnsubscribe?: () => void;
    private captureDurationMs = 60000;
    private readonly fileGenerator: DebugFileGenerator;

    constructor(
        private readonly log: Logger,
        private readonly storagePath: string,
    ) {
        this.fileGenerator = new DebugFileGenerator(this.log, this.storagePath);
    }

    public startCapture(wsClient: KseniaWebSocketClient, durationMs = 60000): void {
        if (this.isCapturing) {
            this.log.warn('Debug capture already in progress');
            return;
        }

        const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
        this.log.warn('');
        this.log.warn('═══════════════════════════════════════════════════════════');
        this.log.warn(`[DEBUG] DEBUG CAPTURE STARTED - ${durationSeconds} SECONDS`);
        this.log.warn('═══════════════════════════════════════════════════════════');
        this.log.warn('[ACTION] NOW: Open Ksenia app and TEST ALL NON-WORKING ENTITIES!');
        this.log.warn('   - Turn lights ON/OFF');
        this.log.warn('   - Open/Close covers');
        this.log.warn('   - Activate scenarios');
        this.log.warn('   - Change zones');
        this.log.warn('   - Adjust thermostats');
        this.log.warn(`[TIMER] You have ${durationSeconds} seconds...`);
        this.log.warn('═══════════════════════════════════════════════════════════');
        this.log.warn('');

        this.isCapturing = true;
        this.captureDurationMs = durationMs;
        this.rawMessages = [];
        this.deviceSnapshots = [];
        this.captureDeviceSnapshot(wsClient, 'START');
        this.hookWebSocket(wsClient);

        this.snapshotInterval = setInterval((): void => {
            if (this.isCapturing) {
                this.captureDeviceSnapshot(wsClient, 'INTERVAL');
            }
        }, 10000);

        this.captureTimer = setTimeout(() => {
            if (this.snapshotInterval) {
                clearInterval(this.snapshotInterval);
                this.snapshotInterval = undefined;
            }
            this.stopCapture(wsClient);
        }, durationMs);
    }

    public stopCapture(wsClient: KseniaWebSocketClient): void {
        if (!this.isCapturing) {
            return;
        }

        this.log.warn('');
        this.log.warn('═══════════════════════════════════════════════════════════');
        this.log.warn('[DONE] DEBUG CAPTURE COMPLETED');
        this.log.warn('═══════════════════════════════════════════════════════════');

        this.isCapturing = false;
        if (this.captureTimer) {
            clearTimeout(this.captureTimer);
            this.captureTimer = undefined;
        }
        if (this.snapshotInterval) {
            clearInterval(this.snapshotInterval);
            this.snapshotInterval = undefined;
        }

        this.captureDeviceSnapshot(wsClient, 'END');
        this.unhookWebSocket();
        this.fileGenerator.generate(this.rawMessages, this.deviceSnapshots, this.captureDurationMs);
    }

    private captureDeviceSnapshot(
        wsClient: KseniaWebSocketClient,
        label: 'START' | 'INTERVAL' | 'END',
    ): void {
        const devices = wsClient.getAllDevices ? wsClient.getAllDevices() : [];
        this.deviceSnapshots.push({
            timestamp: new Date().toISOString(),
            label,
            deviceCount: devices.length,
            devices: JSON.parse(JSON.stringify(devices)),
        });
    }

    private hookWebSocket(wsClient: KseniaWebSocketClient): void {
        try {
            if (this.rawMessageUnsubscribe) {
                this.log.warn('WebSocket hooks already active, skipping re-hook');
                return;
            }

            this.rawMessageUnsubscribe = wsClient.addRawMessageListener(
                (direction: RawMessageDirection, rawMessage: string): void => {
                    if (!this.isCapturing) {
                        return;
                    }
                    this.captureRawMessage(direction, rawMessage);
                },
            );

            this.log.info('[OK] WebSocket hooks installed - capturing ALL traffic');
        } catch (error: unknown) {
            this.log.error(
                'Failed to hook WebSocket:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private unhookWebSocket(): void {
        if (!this.rawMessageUnsubscribe) {
            return;
        }

        try {
            this.rawMessageUnsubscribe();
        } catch (error: unknown) {
            this.log.error(
                'Failed to unhook WebSocket listener:',
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            this.rawMessageUnsubscribe = undefined;
        }
    }

    private captureRawMessage(direction: 'in' | 'out', rawData: string): void {
        try {
            this.rawMessages.push(captureRawMessage(direction, rawData));
        } catch (error: unknown) {
            this.log.error(
                'Failed to capture message:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
