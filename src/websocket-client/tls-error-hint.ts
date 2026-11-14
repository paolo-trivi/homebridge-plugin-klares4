/**
 * Turns the TLS failures a Lares4 panel typically causes into an actionable
 * hint. Both cases are fixed by configuration (`allowInsecureTls`), not by
 * code, so the platform also keeps them out of telemetry.
 */

export interface TlsHintContext {
    useHttps: boolean;
    allowInsecureTls: boolean;
}

/** OpenSSL/Node codes for a self-signed or otherwise unverifiable panel certificate. */
const UNTRUSTED_CERT_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const LEGACY_RENEGOTIATION = /unsafe legacy renegotiation disabled/i;

function errorCode(error: unknown): string | undefined {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Returns a log hint when `error` is a TLS failure that `allowInsecureTls`
 * resolves, or undefined when it is anything else (including the same failure
 * with `allowInsecureTls` already on, which is then a real bug to report).
 */
export function tlsConfigurationHint(error: unknown, context: TlsHintContext): string | undefined {
    if (!context.useHttps || context.allowInsecureTls) {
        return undefined;
    }
    if (LEGACY_RENEGOTIATION.test(errorMessage(error))) {
        return 'The panel requires TLS legacy renegotiation, which Node.js refuses by default. '
            + 'On a trusted local network enable "allowInsecureTls" in the plugin settings and restart Homebridge.';
    }
    const code = errorCode(error);
    if (code !== undefined && UNTRUSTED_CERT_CODES.has(code)) {
        return `The panel TLS certificate cannot be verified (${code}); Lares4 panels use a self-signed certificate. `
            + 'On a trusted local network enable "allowInsecureTls" in the plugin settings and restart Homebridge.';
    }
    return undefined;
}
