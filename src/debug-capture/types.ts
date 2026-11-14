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
    /** The devices as the client knew them, sensitive keys masked (`redactSnapshot`). */
    devices: unknown;
}
