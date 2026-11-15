/** Schemes mqtt.js 5 opens from Node (`mqtt/build/lib/connect/index.js`, protocol table). */
const SUPPORTED_SCHEMES = new Set(['mqtt', 'mqtts', 'tcp', 'tls', 'ssl', 'ws', 'wss']);
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

export type BrokerUrlCheck =
    | { ok: true; url: string; display: string }
    | { ok: false; reason: string };

const PORT_REASON = 'the port in the broker URL must be a number from 1 to 65535';

/**
 * Why `new URL()` refused a `scheme://...` broker URL. An '@' after the first
 * '/', '?' or '#' means the password holds one of them unescaped (the URL
 * parser then reads the start of the password as the port); otherwise a
 * non-numeric or too large port is the usual cause.
 */
function unparsableReason(url: string): string {
    const rest = url.slice(SCHEME_PREFIX.exec(url)?.[0].length ?? 0);
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    if (authorityEnd !== -1 && rest.indexOf('@', authorityEnd) !== -1) {
        return 'the broker URL cannot be parsed: a password with /, # or ? must be percent-encoded (%2F, %23, %3F)';
    }
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const port = /^(?:\[[^\]]*\]|[^:]*):(.*)$/.exec(hostPort)?.[1];
    if (port !== undefined && port !== '' && !(/^\d+$/.test(port) && Number(port) <= 65535)) return PORT_REASON;
    return 'the broker URL cannot be parsed (check the host name, and percent-encode special characters in the password)';
}

/**
 * Validates the broker URL before mqtt.js sees it. mqtt.js parses with the
 * legacy `url.parse` and fills what is missing with defaults: `host:1883`
 * becomes host `host` with no protocol, and `mqtt:/user:pw@host` (one slash)
 * becomes `localhost:1883`. Only `scheme://host[:port][/path]` with a scheme
 * mqtt.js supports is accepted, so a typo never connects somewhere else.
 * The reason never contains the URL (it may carry a password).
 */
export function checkBrokerUrl(brokerUrl: string): BrokerUrlCheck {
    const url = brokerUrl.trim();
    if (url === '') return { ok: false, reason: 'the broker URL is empty' };
    if (!SCHEME_PREFIX.test(url)) {
        return { ok: false, reason: 'the broker URL must start with mqtt://, mqtts://, ws:// or wss://' };
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, reason: unparsableReason(url) };
    }
    if (parsed.port === '0') return { ok: false, reason: PORT_REASON };
    const scheme = parsed.protocol.replace(/:$/, '');
    if (!SUPPORTED_SCHEMES.has(scheme)) {
        return { ok: false, reason: `unsupported scheme "${scheme}" (use mqtt, mqtts, ws or wss)` };
    }
    if (parsed.hostname === '') return { ok: false, reason: 'the broker URL has no host' };
    return { ok: true, url, display: `${scheme}://${parsed.host}` };
}
