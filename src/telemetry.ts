import * as Sentry from '@sentry/node';

const SENTRY_DSN = 'https://6a99b131b91b591e7a98ea136e8c4837@o4511676680699904.ingest.de.sentry.io/4511676714647632';

const SENSITIVE_KEYS = /^(pin|password|token|secret|ip|ipaddress|host|hostname|url|sender|config|payload|name|devicename|room|roomname|device)$/i;

// Network errors embed the panel address in the *message* itself, e.g.
// "connect ECONNREFUSED 192.168.1.10:443" or "getaddrinfo ENOTFOUND lares.local".
// Key-based scrubbing can't catch those, so every outgoing text field is also
// passed through these value-level patterns (URLs first: they may contain IPs).
const URL_PATTERN = /\b(?:wss?|https?):\/\/[^\s"')]+/gi;
const IPV4_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;

let initialized = false;
/** Exact config-derived strings (panel IP/host, PIN, sender) scrubbed from every text field. */
let sensitiveValues: string[] = [];

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scrub URLs, IPv4 addresses and configured sensitive strings from free text. */
function scrubText(text: string): string {
    let out = text.replace(URL_PATTERN, '[url]').replace(IPV4_PATTERN, '[ip]');
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
        }
    }

    // Scrub sensitive keys and string values from extra
    if (event.extra) {
        scrubRecordValues(event.extra);
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

    if (telemetryEnabled === false || initialized) {
        return;
    }

    Sentry.init({
        dsn: SENTRY_DSN,
        release: `homebridge-plugin-klares4@${version}`,
        environment: 'production',
        sampleRate: 1.0,
        // Disable all default integrations that could capture HTTP, console, etc.
        defaultIntegrations: false,
        integrations: [
            Sentry.linkedErrorsIntegration(),
            Sentry.dedupeIntegration(),
            Sentry.inboundFiltersIntegration(),
            Sentry.functionToStringIntegration(),
        ],
        beforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
            return sanitizeEventData(event);
        },
    });

    initialized = true;
}

/** Reports an error to Sentry. No-op when telemetry is disabled. */
export function captureError(error: unknown, context?: Record<string, string>): void {
    if (!initialized) {
        return;
    }
    Sentry.captureException(error, context ? { extra: context } : undefined);
}

/** Sends an informational message to Sentry. No-op when telemetry is disabled. */
export function captureMessage(msg: string, level?: 'info' | 'warning' | 'error'): void {
    if (!initialized) {
        return;
    }
    Sentry.captureMessage(msg, level ?? 'info');
}

/**
 * Flushes pending events and closes Sentry.
 * Uses a short timeout to avoid blocking Homebridge shutdown.
 * Never throws.
 */
export function closeTelemetry(): void {
    if (!initialized) {
        return;
    }
    initialized = false;
    void Sentry.close(2000).catch(() => { /* swallow — never block shutdown */ });
}

/**
 * Resets internal state. Intended for tests only.
 * @internal
 */
export function _resetForTesting(): void {
    initialized = false;
    sensitiveValues = [];
}
