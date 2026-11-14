import type { Logger } from 'homebridge';

import { getEffectiveLogLevel, LogLevel } from '../log-levels';
import type { MatterDeviceOverride, MatterExposureConfig, Lares4Config, RawLares4Config } from './types';
import {
    ConfigIssues,
    isPlainObject,
    readBoolean,
    readNumber,
    readString,
    typeName,
} from './config-values';
import { parseCustomNames, type CustomNameRow, type CustomNamesConfig, type CustomNamesMap } from './custom-names-config';
import { normalizeExclusionLists, type ExclusionKey } from './exclusion-lists';
import {
    normalizeMatterOverrides,
    normalizeMatterRecoveryRequests,
    toMatterOverrideEntries,
    toMatterRecoveryEntries,
} from './matter-override-config';
import { limit } from './runtime-config-limits';
import {
    resolveDomusThermostat,
    resolveKsaImport,
    resolveMatterExposure,
    resolveRoomMapping,
    resolveTemperatureDefaults,
    type ResolvedDomusThermostat,
    type ResolvedKsaImport,
    type ResolvedRoomMapping,
} from './runtime-config-sections';

export interface RuntimeMqttConfig {
    enabled: boolean;
    broker: string;
    port?: number;
    username?: string;
    password?: string;
    clientId?: string;
    topicPrefix: string;
    qos: 0 | 1 | 2;
    retain: boolean;
    /** `false`: publish state only, never subscribe to the command topics. */
    commands: boolean;
}

/**
 * The user's configuration after validation: every key typed, every default
 * applied, every number inside the limits of `config.schema.json`. This is
 * the only place the raw Homebridge config is interpreted; the rest of the
 * plugin reads this (or `platform.config`, which carries the same values).
 * Only keys that have no default stay optional.
 */
export interface RuntimeConfig {
    /** No default: the plugin cannot start without them. */
    ip?: string;
    pin?: string;
    /** The PIN was present but of a type that cannot be one (already reported as an error). */
    pinRejected: boolean;
    https: boolean;
    /** The configured port, else 443 with `https` and 80 without. */
    port: number;
    sender: string;
    allowInsecureTls: boolean;
    debug: boolean;
    /** The level in force: `logLevel`, else DEBUG when `debug` is on, else NORMAL. */
    logLevel: LogLevel;
    generateDebugFile: boolean;
    debugCaptureDurationMs: number;
    maxSeconds: number;
    reconnectInterval: number;
    heartbeatInterval: number;
    commandTimeoutMs: number;
    coverStepSize: number;
    scenarioAutoOffDelay: number;
    devicesSummaryDelay: number;
    /** Unset keeps the Matter coordinator's own resolution (environment variable, then 3000). */
    matterUnregisterTimeoutMs?: number;
    exposePartialArmScenarios: boolean;
    /** Panel IDs, compared exactly. */
    exclusions: Record<ExclusionKey, string[]>;
    matterExposure: Record<keyof MatterExposureConfig, boolean>;
    /** Categories set explicitly (as opposed to defaulted). */
    matterExposureExplicit: ReadonlySet<keyof MatterExposureConfig>;
    /** By device ID, one merged entry per device. Read with own-property lookups only. */
    matterOverrides: Record<string, MatterDeviceOverride>;
    matterRecoveryRequests: Record<string, number>;
    customNames: CustomNamesMap;
    /** The user's `customNames` reduced to its valid entries, in the form it was written in. */
    customNamesConfig: CustomNamesConfig;
    customNameRows: CustomNameRow[];
    temperatureDefaults: { target: number; min: number; max: number; step: number };
    domusThermostat: ResolvedDomusThermostat;
    ksaImport: ResolvedKsaImport;
    roomMapping: ResolvedRoomMapping;
    mqtt?: RuntimeMqttConfig;
}

function readPin(raw: unknown, issues: ConfigIssues): { pin?: string; rejected: boolean } {
    if (raw === undefined || raw === null || raw === '') return { rejected: false };
    // A PIN typed as a number in the JSON editor would escape every string-based mask and scrub.
    if (typeof raw === 'string') return { pin: raw, rejected: false };
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return { pin: String(raw), rejected: false };
    issues.error('pin', `must be a string or a number, received ${typeName(raw)}`);
    return { rejected: true };
}

function readMqtt(raw: unknown, issues: ConfigIssues): RuntimeMqttConfig | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!isPlainObject(raw)) {
        issues.warn('mqtt', `expected an object, received ${typeName(raw)}; MQTT stays off`);
        return undefined;
    }
    const text = (field: string): string | undefined => readString(raw[field], `mqtt.${field}`, issues);
    const port = readNumber(raw.port, limit('mqtt.port'), 'mqtt.port', issues);
    const username = text('username');
    const password = text('password');
    const clientId = text('clientId');
    const topicPrefix = text('topicPrefix');
    const qos = readNumber(raw.qos, limit('mqtt.qos'), 'mqtt.qos', issues);
    return {
        enabled: readBoolean(raw.enabled, false, 'mqtt.enabled', issues),
        broker: text('broker') ?? '',
        ...(port !== undefined ? { port } : {}),
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(clientId !== undefined ? { clientId } : {}),
        topicPrefix: topicPrefix?.trim() ? topicPrefix : 'homebridge/klares4',
        qos: qos === 0 || qos === 2 ? qos : 1,
        retain: readBoolean(raw.retain, true, 'mqtt.retain', issues),
        commands: readBoolean(raw.commands, true, 'mqtt.commands', issues),
    };
}

function readLogLevel(raw: RawLares4Config, debug: boolean, issues: ConfigIssues): LogLevel {
    const configured = readNumber(raw.logLevel, { ...limit('logLevel'), default: undefined }, 'logLevel', issues);
    return getEffectiveLogLevel(configured, debug);
}

function readSender(raw: unknown, issues: ConfigIssues): string {
    const sender = readString(raw, 'sender', issues)?.trim();
    if (sender === '') issues.warn('sender', 'is empty; using the default (homebridge)');
    return sender || 'homebridge';
}

/** The panel address, trimmed; a non-string is reported and treated as missing. */
function readIp(raw: unknown, issues: ConfigIssues): string | undefined {
    const ip = readString(raw, 'ip', issues)?.trim();
    return ip || undefined;
}

/**
 * Validates and normalizes the raw config. Problems are collected and logged
 * once, grouped (errors individually, warnings in a single entry); nothing
 * here throws, whatever the user wrote. Never logs the PIN, the MQTT password
 * or the panel address.
 */
export function resolveRuntimeConfig(raw: RawLares4Config | undefined, log: Logger): RuntimeConfig {
    const config: RawLares4Config = raw ?? { platform: '' };
    const issues = new ConfigIssues();
    const flag = (key: keyof RawLares4Config & string, defaultValue: boolean): boolean =>
        readBoolean(config[key], defaultValue, key, issues);

    const https = flag('https', true);
    const debug = flag('debug', false);
    const { pin, rejected } = readPin(config.pin, issues);
    const names = parseCustomNames(config.customNames, issues);
    const exposure = resolveMatterExposure(config.matterExposure, issues);
    const unregisterTimeout = config.matterUnregisterTimeoutMs === undefined || config.matterUnregisterTimeoutMs === null
        ? undefined
        : readNumber(config.matterUnregisterTimeoutMs, limit('matterUnregisterTimeoutMs'), 'matterUnregisterTimeoutMs', issues);
    const port = readNumber(config.port, limit('port'), 'port', issues);
    const ip = readIp(config.ip, issues);
    const number = <K extends 'maxSeconds' | 'reconnectInterval' | 'heartbeatInterval' | 'commandTimeoutMs'
        | 'coverStepSize' | 'scenarioAutoOffDelay' | 'devicesSummaryDelay' | 'debugCaptureDurationMs'>(key: K): number =>
        readNumber(config[key], limit(key), key, issues);

    const runtime: RuntimeConfig = {
        ...(ip !== undefined ? { ip } : {}),
        ...(pin !== undefined ? { pin } : {}),
        pinRejected: rejected,
        https,
        port: port ?? (https ? 443 : 80),
        sender: readSender(config.sender, issues),
        allowInsecureTls: flag('allowInsecureTls', false),
        debug,
        logLevel: readLogLevel(config, debug, issues),
        generateDebugFile: flag('generateDebugFile', false),
        debugCaptureDurationMs: number('debugCaptureDurationMs'),
        maxSeconds: number('maxSeconds'),
        reconnectInterval: number('reconnectInterval'),
        heartbeatInterval: number('heartbeatInterval'),
        commandTimeoutMs: number('commandTimeoutMs'),
        coverStepSize: number('coverStepSize'),
        scenarioAutoOffDelay: number('scenarioAutoOffDelay'),
        devicesSummaryDelay: number('devicesSummaryDelay'),
        ...(unregisterTimeout !== undefined ? { matterUnregisterTimeoutMs: unregisterTimeout } : {}),
        exposePartialArmScenarios: flag('exposePartialArmScenarios', false),
        exclusions: normalizeExclusionLists(config, issues),
        matterExposure: exposure.exposure,
        matterExposureExplicit: exposure.explicit,
        matterOverrides: normalizeMatterOverrides(config.matterOverrides, issues),
        matterRecoveryRequests: normalizeMatterRecoveryRequests(config.matterRecoveryRequests, issues),
        customNames: names.map,
        customNamesConfig: names.cleaned ?? [],
        customNameRows: names.rows,
        temperatureDefaults: resolveTemperatureDefaults(config.temperatureDefaults, issues),
        domusThermostat: resolveDomusThermostat(config.domusThermostat, issues),
        ksaImport: resolveKsaImport(config.ksaImport, issues),
        roomMapping: resolveRoomMapping(config.roomMapping, issues),
        ...(config.mqtt !== undefined && config.mqtt !== null ? { mqtt: readMqtt(config.mqtt, issues) } : {}),
    };
    issues.flush(log);
    return runtime;
}

/**
 * `platform.config`: the raw config (unknown keys such as `platform`, `name`
 * or `telemetry` untouched) with every key this plugin reads replaced by its
 * validated value, so code that still reads the config directly sees
 * normalized values. The Homebridge-owned config object is not modified.
 */
export function toPlatformConfig(raw: RawLares4Config | undefined, runtime: RuntimeConfig): Lares4Config {
    return {
        platform: '',
        ...raw,
        ip: runtime.ip,
        pin: runtime.pin,
        https: runtime.https,
        port: runtime.port,
        sender: runtime.sender,
        allowInsecureTls: runtime.allowInsecureTls,
        debug: runtime.debug,
        logLevel: runtime.logLevel,
        generateDebugFile: runtime.generateDebugFile,
        debugCaptureDurationMs: runtime.debugCaptureDurationMs,
        maxSeconds: runtime.maxSeconds,
        reconnectInterval: runtime.reconnectInterval,
        heartbeatInterval: runtime.heartbeatInterval,
        commandTimeoutMs: runtime.commandTimeoutMs,
        coverStepSize: runtime.coverStepSize,
        scenarioAutoOffDelay: runtime.scenarioAutoOffDelay,
        devicesSummaryDelay: runtime.devicesSummaryDelay,
        matterUnregisterTimeoutMs: runtime.matterUnregisterTimeoutMs,
        exposePartialArmScenarios: runtime.exposePartialArmScenarios,
        excludeZones: runtime.exclusions.excludeZones,
        excludeOutputs: runtime.exclusions.excludeOutputs,
        excludeSensors: runtime.exclusions.excludeSensors,
        excludeScenarios: runtime.exclusions.excludeScenarios,
        // Only what the user set: the policy tells "category" from "default" by it.
        matterExposure: Object.fromEntries([...runtime.matterExposureExplicit].map((key) => [key, runtime.matterExposure[key]])),
        matterOverrides: toMatterOverrideEntries(runtime.matterOverrides),
        matterRecoveryRequests: toMatterRecoveryEntries(runtime.matterRecoveryRequests),
        customNames: runtime.customNamesConfig,
        temperatureDefaults: { ...runtime.temperatureDefaults },
        domusThermostat: { ...runtime.domusThermostat },
        ksaImport: { ...runtime.ksaImport },
        roomMapping: { ...runtime.roomMapping },
        mqtt: runtime.mqtt,
    };
}
