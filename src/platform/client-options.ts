import type { Logger } from 'homebridge';
import type { KsaSanitizedCache, KseniaWebSocketOptions } from '../types';
import { KseniaWebSocketClient } from '../websocket-client';
import type { ExposurePolicySource } from './discovery-service';
import type { RuntimeConfig } from './runtime-config';
import type { RawLares4Config } from './types';

/** Everything `KseniaWebSocketClient` needs from the config, besides the logger. */
export interface ClientConnectionSettings {
    ip: string;
    port: number;
    useHttps: boolean;
    sender: string;
    pin: string;
    options: KseniaWebSocketOptions;
}

/** The connection fields are present: `ip` and `pin` have no default. */
export type ConnectableRuntimeConfig = RuntimeConfig & { ip: string; pin: string };

/** Logs what is missing and returns false when the client cannot be built. */
export function hasConnectionConfig(config: RawLares4Config | undefined, runtime: RuntimeConfig, log: Logger): boolean {
    if (!config) {
        log.error('No configuration found');
        return false;
    }
    if (!runtime.ip) {
        // A non-string address was already reported by the validation.
        if (config.ip === undefined || config.ip === null || config.ip === '') log.error('IP address missing in configuration');
        return false;
    }
    if (!runtime.pin) {
        // A PIN of an unusable type was already reported by the validation.
        if (!runtime.pinRejected) log.error('PIN missing in configuration');
        return false;
    }
    return true;
}

export function buildClientConnectionSettings(
    config: ConnectableRuntimeConfig,
    ksaCache: KsaSanitizedCache | undefined,
): ClientConnectionSettings {
    return {
        ip: config.ip,
        port: config.port,
        useHttps: config.https,
        sender: config.sender,
        pin: config.pin,
        options: {
            debug: config.debug,
            logLevel: config.logLevel,
            reconnectInterval: config.reconnectInterval,
            heartbeatInterval: config.heartbeatInterval,
            commandTimeoutMs: config.commandTimeoutMs,
            allowInsecureTls: config.allowInsecureTls,
            exposePartialArmScenarios: config.exposePartialArmScenarios,
            // Absent rather than empty: the default options stay what they were before these keys.
            ...(config.exposeOutputs.length > 0 ? { exposeOutputs: config.exposeOutputs } : {}),
            ...(config.exposeScenarios.length > 0 ? { exposeScenarios: config.exposeScenarios } : {}),
            domusThermostat: config.domusThermostat,
            ksaCache,
        },
    };
}

/** Creates the panel client from the runtime config; nothing connects until `connect()`. */
export function createWebSocketClient(
    config: ConnectableRuntimeConfig,
    log: Logger,
    ksaCache: KsaSanitizedCache | undefined,
): KseniaWebSocketClient {
    const settings = buildClientConnectionSettings(config, ksaCache);
    const client = new KseniaWebSocketClient(
        settings.ip,
        settings.port,
        settings.useHttps,
        settings.sender,
        settings.pin,
        log,
        settings.options,
    );
    if (config.allowInsecureTls) {
        log.warn(
            'TLS certificate verification is disabled (allowInsecureTls=true). Use only on trusted local networks.',
        );
    }
    return client;
}

/**
 * What the client hid with the exposure policy, in the form `DiscoveryService`
 * reads. The facade reports suppressed scenarios today; outputs follow once
 * it exposes the hidden-device registry (`isHiddenByExposurePolicy`).
 */
export function clientExposurePolicy(client: KseniaWebSocketClient): ExposurePolicySource {
    return {
        isHiddenByExposurePolicy: (deviceId: string): boolean =>
            deviceId.startsWith('scenario_') && client.isScenarioSuppressed(deviceId),
    };
}
