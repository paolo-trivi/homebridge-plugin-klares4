import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import type { KseniaWebSocketClient } from './websocket-client';
import type { KseniaDevice } from './types';

/**
 * Raw WebSocket message capture
 */
interface RawMessage {
    timestamp: string;
    direction: 'in' | 'out';
    rawData: string;
    parsed?: any;
}

/**
 * Debug capture manager - comprehensive WebSocket recording
 * Captures EVERYTHING for 60 seconds to help diagnose non-working entities
 */
export class DebugCaptureManager {
    private rawMessages: RawMessage[] = [];
    private devices: KseniaDevice[] = [];
    private isCapturing = false;
    private captureTimer?: NodeJS.Timeout;
    private deviceSnapshots: any[] = [];

    constructor(
        private readonly log: Logger,
        private readonly storagePath: string,
    ) {}

    /**
     * Start comprehensive capture - records EVERYTHING
     */
    public startCapture(
        wsClient: KseniaWebSocketClient,
        durationMs = 60000,
    ): void {
        if (this.isCapturing) {
            this.log.warn('Debug capture already in progress');
            return;
        }

        this.log.warn('');
        this.log.warn('═══════════════════════════════════════════════════════════');
        this.log.warn('🔍 DEBUG CAPTURE STARTED - 60 SECONDS');
        this.log.warn('═══════════════════════════════════════════════════════════');
        this.log.warn('📱 NOW: Open Ksenia app and TEST ALL NON-WORKING ENTITIES!');
        this.log.warn('   - Turn lights ON/OFF');
        this.log.warn('   - Open/Close covers');
        this.log.warn('   - Activate scenarios');
        this.log.warn('   - Change zones');
        this.log.warn('   - Adjust thermostats');
        this.log.warn('⏱️  You have 60 seconds...');
        this.log.warn('═══════════════════════════════════════════════════════════');
        this.log.warn('');
        
        this.isCapturing = true;
        this.rawMessages = [];
        this.deviceSnapshots = [];
        
        // Initial device snapshot
        this.captureDeviceSnapshot(wsClient, 'START');
        
        // Hook WebSocket to capture ALL messages
        this.hookWebSocket(wsClient);

        // Take snapshots every 10 seconds
        const snapshotInterval = setInterval(() => {
            if (this.isCapturing) {
                this.captureDeviceSnapshot(wsClient, 'INTERVAL');
            }
        }, 10000);

        // Auto-stop after duration
        this.captureTimer = setTimeout(() => {
            clearInterval(snapshotInterval);
            this.stopCapture(wsClient);
        }, durationMs);
    }

    /**
     * Capture device snapshot
     */
    private captureDeviceSnapshot(wsClient: KseniaWebSocketClient, label: string): void {
        const devices = wsClient.getAllDevices ? wsClient.getAllDevices() : [];
        this.deviceSnapshots.push({
            timestamp: new Date().toISOString(),
            label,
            deviceCount: devices.length,
            devices: JSON.parse(JSON.stringify(devices)), // Deep clone
        });
    }

    /**
     * Hook into WebSocket to capture ALL raw messages
     */
    private hookWebSocket(wsClient: any): void {
        try {
            const ws = (wsClient as any).ws;
            
            if (!ws) {
                this.log.error('WebSocket not available for capture');
                return;
            }

            // Intercept ALL incoming messages (preserve original handler)
            const originalListeners = ws.listeners('message');
            ws.removeAllListeners('message');
            
            ws.on('message', (data: any) => {
                if (this.isCapturing) {
                    this.captureRawMessage('in', data.toString());
                }
                // Call original handlers
                originalListeners.forEach((listener: any) => listener(data));
            });

            // Intercept ALL outgoing messages
            const originalSend = ws.send.bind(ws);
            ws.send = (data: any, ...args: any[]) => {
                if (this.isCapturing) {
                    this.captureRawMessage('out', typeof data === 'string' ? data : data.toString());
                }
                return originalSend(data, ...args);
            };

            this.log.info('✅ WebSocket hooks installed - capturing ALL traffic');
        } catch (error: unknown) {
            this.log.error(
                'Failed to hook WebSocket:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * Capture raw message with full details
     */
    private captureRawMessage(direction: 'in' | 'out', rawData: string): void {
        try {
            let parsed: any = null;
            let maskedData = rawData;
            
            try {
                parsed = JSON.parse(rawData);
                // Mask PIN but keep everything else
                if (parsed.PAYLOAD?.PIN) {
                    const maskedParsed = JSON.parse(JSON.stringify(parsed));
                    maskedParsed.PAYLOAD.PIN = '***MASKED***';
                    maskedData = JSON.stringify(maskedParsed);
                }
            } catch {
                // Not JSON, keep as-is
            }

            this.rawMessages.push({
                timestamp: new Date().toISOString(),
                direction,
                rawData: maskedData,
                parsed,
            });
        } catch (error: unknown) {
            this.log.error(
                'Failed to capture message:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    /**
     * Stop capture and generate comprehensive debug file
     */
    public stopCapture(wsClient: KseniaWebSocketClient): void {
        if (!this.isCapturing) {
            return;
        }

        this.log.warn('');
        this.log.warn('═══════════════════════════════════════════════════════════');
        this.log.warn('🛑 DEBUG CAPTURE COMPLETED');
        this.log.warn('═══════════════════════════════════════════════════════════');
        
        this.isCapturing = false;

        if (this.captureTimer) {
            clearTimeout(this.captureTimer);
            this.captureTimer = undefined;
        }

        // Final device snapshot
        this.captureDeviceSnapshot(wsClient, 'END');

        // Generate comprehensive debug file
        this.generateComprehensiveDebugFile();
    }

    /**
     * Generate comprehensive debug file with ALL data
     */
    private generateComprehensiveDebugFile(): void {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const filename = `klares4-debug-${timestamp}.json`;
            const filepath = path.join(this.storagePath, filename);

            // Analyze messages to extract useful info
            const messagesByType = this.analyzeMessages();
            const commandsSeen = this.extractCommands();

            const debugData = {
                generated: new Date().toISOString(),
                version: '1.1.7',
                captureInfo: {
                    duration: '60 seconds',
                    totalRawMessages: this.rawMessages.length,
                    incomingMessages: this.rawMessages.filter(m => m.direction === 'in').length,
                    outgoingMessages: this.rawMessages.filter(m => m.direction === 'out').length,
                    deviceSnapshotsTaken: this.deviceSnapshots.length,
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
                deviceSnapshots: this.deviceSnapshots,
                rawMessages: this.rawMessages,
                analysis: {
                    messagesByType: messagesByType,
                    commandsSeen: commandsSeen,
                    uniquePayloadTypes: this.getUniquePayloadTypes(),
                },
                statistics: {
                    messages: {
                        total: this.rawMessages.length,
                        incoming: this.rawMessages.filter(m => m.direction === 'in').length,
                        outgoing: this.rawMessages.filter(m => m.direction === 'out').length,
                        byCommand: this.countByCommand(),
                    },
                    devices: this.deviceSnapshots.length > 0 
                        ? this.deviceSnapshots[this.deviceSnapshots.length - 1].deviceCount 
                        : 0,
                },
            };

            fs.writeFileSync(filepath, JSON.stringify(debugData, null, 2));
            
            this.log.warn('✅ COMPREHENSIVE DEBUG FILE GENERATED!');
            this.log.warn('📁 Location: ' + filepath);
            this.log.warn('📊 Contains:');
            this.log.warn(`   - ${debugData.rawMessages.length} raw WebSocket messages`);
            this.log.warn(`   - ${debugData.deviceSnapshots.length} device snapshots`);
            this.log.warn(`   - ${debugData.statistics.devices} total devices`);
            this.log.warn('');
            this.log.warn('📤 Share this file for support - PINs are already masked!');
            this.log.warn('═══════════════════════════════════════════════════════════');
            this.log.warn('');
        } catch (error: unknown) {
            this.log.error(
                '❌ Error generating debug file:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private analyzeMessages(): any {
        const byType: Record<string, number> = {};
        this.rawMessages.forEach(msg => {
            if (msg.parsed?.CMD) {
                const key = `${msg.direction}:${msg.parsed.CMD}`;
                byType[key] = (byType[key] || 0) + 1;
            }
        });
        return byType;
    }

    private extractCommands(): string[] {
        const commands = new Set<string>();
        this.rawMessages.forEach(msg => {
            if (msg.parsed?.CMD) {
                commands.add(msg.parsed.CMD);
            }
        });
        return Array.from(commands).sort();
    }

    private getUniquePayloadTypes(): string[] {
        const types = new Set<string>();
        this.rawMessages.forEach(msg => {
            if (msg.parsed?.PAYLOAD_TYPE) {
                types.add(msg.parsed.PAYLOAD_TYPE);
            }
        });
        return Array.from(types).sort();
    }

    private countByCommand(): Record<string, number> {
        const counts: Record<string, number> = {};
        this.rawMessages.forEach(msg => {
            if (msg.parsed?.CMD) {
                counts[msg.parsed.CMD] = (counts[msg.parsed.CMD] || 0) + 1;
            }
        });
        return counts;
    }
}
