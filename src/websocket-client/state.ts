import type { WebSocketClientState } from './types';

export function createInitialWebSocketClientState(): WebSocketClientState {
    return {
        isConnected: false,
        heartbeatPending: false,
        lastPongReceived: 0,
        reconnectAttempts: 0,
        isManualClose: false,
        hasCompletedInitialSync: false,
        pendingOutputStatuses: new Map(),
        pendingSensorStatuses: new Map(),
        pendingZoneStatuses: new Map(),
        devices: new Map(),
    };
}
