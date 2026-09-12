import type { API, Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { KseniaWebSocketClient } from '../websocket-client';

export type MatterRegistrationStatus = 'pending' | 'registered' | 'failed' | 'skipped';

export interface MatterRegistryDeps {
    api: API;
    log: Logger;
    getWsClient: () => KseniaWebSocketClient | undefined;
    storagePath: string;
    momentaryAutoOffMs?: number;
    isDeviceExposed?: (device: KseniaDevice) => boolean;
    recoveryRequests?: Record<string, number>;
}
