import * as os from 'os';
import * as path from 'path';
import * as Sentry from '@sentry/node';
import type { NodeOptions } from '@sentry/node';

const SENTRY_DSN = 'https://6a99b131b91b591e7a98ea136e8c4837@o4511676680699904.ingest.de.sentry.io/4511676714647632';

const SENSITIVE_KEYS = /^(pin|password|token|secret|ip|ipaddress|host|hostname|url|sender|config|payload|name|devicename|room|roomname|device)$/i;

// Network errors embed the panel address in the *message* itself, e.g.
// "connect ECONNREFUSED 192.168.1.10:443" or "getaddrinfo ENOTFOUND lares.local".
// Key-based scrubbing can't catch those, so every outgoing text field is also
// passed through these value-level patterns (URLs first: they may contain IPs).
const URL_PATTERN = /\b(?:wss?|https?):\/\/[^\s"')]+/gi;
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;

// Absolute paths carry the user name (/home/<user>, C:\Users\<user>).
const PLUGIN_NAME = 'homebridge-plugin-klares4';
const PLUGIN_ROOT = toPosixPath(path.resolve(__dirname, '..'));
const HOME_DIR = readHomeDir();

/**
 * Dedicated client + scope instead of `Sentry.init`: Homebridge runs many
 * plugins in one process, and `init` installs a process-global client that
 * another plugin's `init` can replace (or that would receive its events).
 * Nothing here touches the global carrier.
 */
let client: Sentry.NodeClient | undefined;
let scope: Sentry.Scope | undefined;
/** Test-only transport factory; production always uses Sentry's Node transport. */
let transportOverride: NodeOptions['transport'] | undefined;
/** Exact config-derived strings (panel IP/host, PIN, sender) scrubbed from every text field. */
let sensitiveValues: string[] = [];

function toPosixPath(value: string): string {
    return value.replace(/\\/g, '/');
}

function readHomeDir(): string | undefined {
    try {
        const home = os.homedir();
        return home.length > 1 ? home : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Reduces a stack frame path to something without the user's directories:
 * the part after the last node_modules/, the path inside this plugin, or
 * the bare file name. Non-absolute paths (node:internal/...) are kept.
 */
function scrubFramePath(framePath: string): string {
    const normalized = toPosixPath(framePath).replace(/^file:\/\//i, '');
    const nodeModulesAt = normalized.lastIndexOf('/node_modules/');
    if (nodeModulesAt !== -1) {
        return normalized.slice(nodeModulesAt + '/node_modules/'.length);
    }
    if (normalized.startsWith(`${PLUGIN_ROOT}/`)) {
        return `${PLUGIN_NAME}/${normalized.slice(PLUGIN_ROOT.length + 1)}`;
    }
    if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) {
        return normalized.slice(normalized.lastIndexOf('/') + 1);
    }
    return framePath;
}

function scrubStackFrames(frames: Sentry.StackFrame[] | undefined): void {
    for (const frame of frames ?? []) {
        if (typeof frame.filename === 'string') {
            frame.filename = scrubFramePath(frame.filename);
        }
        if (typeof frame.abs_path === 'string') {
            frame.abs_path = scrubFramePath(frame.abs_path);
        }
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scrub URLs, IPv4 addresses and configured sensitive strings from free text. */
function scrubText(text: string): string {
    let out = text.replace(URL_PATTERN, '[url]').replace(IPV4_PATTERN, '[ip]');
    if (HOME_DIR) {
        out = out.split(HOME_DIR).join('~');
    }
    for (const value of sensitiveValues) {
        out = out.replace(new RegExp(escapeRegExp(value), 'gi'), '[redacted]');
    }
    return out;
}

function scrubRecordValues(record: Record<string, unknown>): void {
    for (const key of Object.keys(record)) {
        if (SENSITIVE_KEYS.test(key)) {
            delete record[key];
            continue;
        }
        const value = record[key];
        if (typeof value === 'string') {
            record[key] = scrubText(value);
        }
    }
}

/**
 * Strips sensitive fields from a Sentry event before it leaves the process.
 * Exported for testing.
 */
export function sanitizeEventData(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
    // Never send user, request or machine-identifying data
    delete event.user;
    delete event.request;
    delete event.server_name;

    // Scrub error messages: network errors carry the panel address in the text
    if (typeof event.message === 'string') {
        event.message = scrubText(event.message);
    }
    if (event.exception?.values) {
        for (const ex of event.exception.values) {
            if (typeof ex.value === 'string') {
                ex.value = scrubText(ex.value);
            }
            scrubStackFrames(ex.stacktrace?.frames);
        }
    }

    // Scrub sensitive keys and string values from extra
    if (event.extra) {
        scrubRecordValues(event.extra);
    }

    // Tags: klares4 sets none, but tags another plugin put on the shared
    // global/isolation scope are merged into every event
    if (event.tags) {
        scrubRecordValues(event.tags);
    }

    // Scrub sensitive keys and string values from contexts
    if (event.contexts) {
        for (const ctxName of Object.keys(event.contexts)) {
            const ctx = event.contexts[ctxName];
            if (ctx && typeof ctx === 'object') {
                scrubRecordValues(ctx);
            }
        }
    }

    // Scrub breadcrumb messages and data
    if (event.breadcrumbs) {
        for (const bc of event.breadcrumbs) {
            if (typeof bc.message === 'string') {
                bc.message = scrubText(bc.message);
            }
            if (bc.data) {
                scrubRecordValues(bc.data);
            }
        }
    }

    return event;
}

/**
 * Initializes Sentry unless `config.telemetry === false` (opt-out, default
 * enabled — see README "Telemetry" and config.schema.json).
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @param sensitive Config-derived strings (panel IP/host, PIN, sender) that
 *   must never appear in an outgoing event, scrubbed by `sanitizeEventData`.
 */
export function initTelemetry(telemetryEnabled: boolean | undefined, version: string, sensitive?: string[]): void {
    // Record the scrub list even when disabled: sanitizeEventData must be safe
    // to exercise (tests) and a later re-init keeps the same guarantees.
    if (sensitive) {
        sensitiveValues = sensitive.filter((v): v is string => typeof v === 'string' && v.length >= 3);
    }

    if (telemetryEnabled === false || scope) {
        return;
    }

    const nodeClient = new Sentry.NodeClient({
        dsn: SENTRY_DSN,
        release: `homebridge-plugin-klares4@${version}`,
        environment: 'production',
        sampleRate: 1.0,
        includeServerName: false,
        transport: transportOverride ?? Sentry.makeNodeTransport,
        stackParser: Sentry.defaultStackParser,
        // Only event processors scoped to this client: nothing that captures
        // HTTP, console or global handlers, or patches process-wide globals.
        integrations: [
            Sentry.linkedErrorsIntegration(),
            Sentry.dedupeIntegration(),
            Sentry.eventFiltersIntegration(),
        ],
        beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
            return sanitizeEventData(event);
        },
    });
    const isolatedScope = new Sentry.Scope();
    isolatedScope.setClient(nodeClient);
    // Integrations are set up by init(), which must follow setClient().
    nodeClient.init();

    client = nodeClient;
    scope = isolatedScope;
}

/** Reports an error to Sentry. No-op when telemetry is disabled. */
export function captureError(error: unknown, context?: Record<string, string>): void {
    if (!scope) {
        return;
    }
    if (context) {
        const eventScope = scope.clone();
        eventScope.setExtras(context);
        eventScope.captureException(error);
        return;
    }
    scope.captureException(error);
}

/** Sends an informational message to Sentry. No-op when telemetry is disabled. */
export function captureMessage(msg: string, level?: 'info' | 'warning' | 'error'): void {
    if (!scope) {
        return;
    }
    scope.captureMessage(msg, level ?? 'info');
}

/**
 * Flushes pending events and closes Sentry.
 * Uses a short timeout to avoid blocking Homebridge shutdown.
 * Never throws; the returned promise never rejects and may be ignored.
 */
export function closeTelemetry(): Promise<void> {
    const closingClient = client;
    client = undefined;
    scope = undefined;
    if (!closingClient) {
        return Promise.resolve();
    }
    return Promise.resolve(closingClient.close(2000)).then(
        () => undefined,
        () => undefined, // swallow — never block shutdown
    );
}

/**
 * Resets internal state. Intended for tests only.
 * @internal
 */
export function _resetForTesting(): void {
    void closeTelemetry();
    sensitiveValues = [];
}

/**
 * Replaces the Sentry transport so tests never reach the real DSN.
 * Takes effect at the next `initTelemetry`; not cleared by `_resetForTesting`.
 * @internal
 */
export function _setTransportForTesting(factory: NodeOptions['transport'] | undefined): void {
    transportOverride = factory;
}
