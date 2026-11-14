import type { API } from 'homebridge';

/**
 * The error a characteristic handler throws when a command failed: HomeKit
 * sees only `SERVICE_COMMUNICATION_FAILURE`, as before, while the error that
 * caused it stays attached as `cause` for the other callers of the handler
 * (the MQTT bridge tells a queue or validation refusal from a real failure).
 */
export function communicationFailure(api: API, error: unknown): Error {
    const failure = new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    // `cause` is not a constructor option of HapStatusError (hap-nodejs 1.x/2.x).
    Object.defineProperty(failure, 'cause', { value: error, enumerable: false, writable: true, configurable: true });
    return failure;
}
