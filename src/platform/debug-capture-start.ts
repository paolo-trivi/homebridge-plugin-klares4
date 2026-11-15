import type { Logger } from 'homebridge';
import { DebugCaptureManager } from '../debug-capture';
import type { KseniaWebSocketClient } from '../websocket-client';

/**
 * Starts the one-shot capture requested by `generateDebugFile`. The duration is
 * `debugCaptureDurationMs` as the runtime config validated it (10 s to 30 min):
 * after a child-bridge restart Apple Home / Matter can need several minutes to
 * become responsive, so the default 60 s window can close before the user can
 * trigger the failing scenario.
 */
export function startRequestedDebugCapture(
    durationMs: number,
    log: Logger,
    storagePath: string,
    client: KseniaWebSocketClient,
): DebugCaptureManager {
    log.warn(`[DEBUG] Debug capture requested - starting ${Math.round(durationMs / 1000)}-second capture...`);
    const capture = new DebugCaptureManager(log, storagePath);
    capture.startCapture(client, durationMs);
    return capture;
}
