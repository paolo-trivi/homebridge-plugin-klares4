import type { KseniaDevice } from '../types';

export interface RawMessage {
    timestamp: string;
    direction: 'in' | 'out';
    rawData: string;
    parsed?: Record<string, unknown> | null;
}

export interface DeviceSnapshot {
    timestamp: string;
    label: 'START' | 'INTERVAL' | 'END';
    deviceCount: number;
    devices: KseniaDevice[];
}
