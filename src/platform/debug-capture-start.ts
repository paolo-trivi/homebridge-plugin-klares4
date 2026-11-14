import type { Logger } from 'homebridge';
import { DebugCaptureManager } from '../debug-capture';
import type { KseniaWebSocketClient } from '../websocket-client';
import type { Lares4Config } from './types';

const DEFAULT_CAPTURE_MS = 60_000;
const MIN_CAPTURE_MS = 10_000;
const MAX_CAPTURE_MS = 1_800_000;

/**
 * After a child-bridge restart, Apple Home / Matter mesh can need several
 * minutes to become responsive again. The default 60s window often closes
 * before the user can trigger the failing scenario from HomeKit, so the
 * window is configurable via `debugCaptureDurationMs`, within 10s..30min.
 */
export function debugCaptureDurationMs(config: Lares4Config): number {
    const requested = config.debugCaptureDurationMs;
    return Math.max(
        MIN_CAPTURE_MS,
        Math.min(MAX_CAPTURE_MS, typeof requested === 'number' && Number.isFinite(requested) ? requested : DEFAULT_CAPTURE_MS),
    );
}

/** Starts the one-shot capture requested by `generateDebugFile`. */
export function startRequestedDebugCapture(
    config: Lares4Config,
    log: Logger,
    storagePath: string,
    client: KseniaWebSocketClient,
): DebugCaptureManager {
    const durationMs = debugCaptureDurationMs(config);
    log.warn(`[DEBUG] Debug capture requested - starting ${Math.round(durationMs / 1000)}-second capture...`);
    const capture = new DebugCaptureManager(log, storagePath);
    capture.startCapture(client, durationMs);
    return capture;
}
