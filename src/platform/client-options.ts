import type { Logger } from 'homebridge';
import { getEffectiveLogLevel } from '../log-levels';
import type { KsaSanitizedCache, KseniaWebSocketOptions } from '../types';
import { KseniaWebSocketClient } from '../websocket-client';
import type { Lares4Config } from './types';

/** Everything `KseniaWebSocketClient` needs from the config, besides the logger. */
export interface ClientConnectionSettings {
    ip: string;
    port: number;
    useHttps: boolean;
    sender: string;
    pin: string;
    options: KseniaWebSocketOptions;
}

/** Logs what is missing and returns false when the client cannot be built. */
export function hasConnectionConfig(config: Lares4Config | undefined, log: Logger): boolean {
    if (!config) {
        log.error('No configuration found');
        return false;
    }
    if (!config.ip) {
        log.error('IP address missing in configuration');
        return false;
    }
    if (!config.pin) {
        log.error('PIN missing in configuration');
        return false;
    }
    return true;
}

export function buildClientConnectionSettings(
    config: Lares4Config & { ip: string; pin: string },
    ksaCache: KsaSanitizedCache | undefined,
): ClientConnectionSettings {
    const useHttps = config.https !== false;
    return {
        ip: config.ip,
        port: config.port ?? (useHttps ? 443 : 80),
        useHttps,
        sender: config.sender ?? 'homebridge',
        pin: config.pin,
        options: {
            debug: config.debug ?? false,
            logLevel: getEffectiveLogLevel(config.logLevel, config.debug),
            reconnectInterval: config.reconnectInterval ?? 5000,
            heartbeatInterval: config.heartbeatInterval ?? 30000,
            commandTimeoutMs: config.commandTimeoutMs ?? 8000,
            allowInsecureTls: config.allowInsecureTls ?? false,
            exposePartialArmScenarios: config.exposePartialArmScenarios === true,
            domusThermostat: config.domusThermostat,
            ksaCache,
        },
    };
}

/** Creates the panel client from the config; nothing connects until `connect()`. */
export function createWebSocketClient(
    config: Lares4Config & { ip: string; pin: string },
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
