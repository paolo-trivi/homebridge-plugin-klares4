import * as Sentry from '@sentry/node';

const SENTRY_DSN = 'https://6a99b131b91b591e7a98ea136e8c4837@o4511676680699904.ingest.de.sentry.io/4511676714647632';

const SENSITIVE_KEYS = /^(pin|password|token|secret|ip|host|url|sender|config|payload|name|room|device)$/i;

let initialized = false;

/**
 * Strips sensitive fields from a Sentry event before it leaves the process.
 * Exported for testing.
 */
export function sanitizeEventData(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
    // Never send user or request data
    delete event.user;
    delete event.request;

    // Scrub sensitive keys from extra
    if (event.extra) {
        for (const key of Object.keys(event.extra)) {
            if (SENSITIVE_KEYS.test(key)) {
                delete event.extra[key];
            }
        }
    }

    // Scrub sensitive keys from contexts
    if (event.contexts) {
        for (const ctxName of Object.keys(event.contexts)) {
            const ctx = event.contexts[ctxName];
            if (ctx && typeof ctx === 'object') {
                for (const key of Object.keys(ctx)) {
                    if (SENSITIVE_KEYS.test(key)) {
                        delete ctx[key];
                    }
                }
            }
        }
    }

    // Scrub breadcrumb data
    if (event.breadcrumbs) {
        for (const bc of event.breadcrumbs) {
            if (bc.data) {
                for (const key of Object.keys(bc.data)) {
                    if (SENSITIVE_KEYS.test(key)) {
                        delete bc.data[key];
                    }
                }
            }
        }
    }

    return event;
}

/**
 * Initializes Sentry only when `config.telemetry === true`.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initTelemetry(telemetryEnabled: boolean | undefined, version: string): void {
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
}
