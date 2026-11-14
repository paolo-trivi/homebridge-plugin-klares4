/** Schemes mqtt.js 5 opens from Node (`mqtt/build/lib/connect/index.js`, protocol table). */
const SUPPORTED_SCHEMES = new Set(['mqtt', 'mqtts', 'tcp', 'tls', 'ssl', 'ws', 'wss']);
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

export type BrokerUrlCheck =
    | { ok: true; url: string; display: string }
    | { ok: false; reason: string };

/**
 * Replaces the `user:password@` part of a broker URL with `***@`, for logging.
 * Leading and trailing spaces are dropped first (mqtt.js accepts them), and a
 * URL without a scheme is masked from its first character.
 */
export function maskBrokerUrl(brokerUrl: string): string {
    const url = brokerUrl.trim();
    const authorityStart = SCHEME_PREFIX.exec(url)?.[0].length ?? 0;
    const rest = url.slice(authorityStart);
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    // The last '@' of the authority: a password with an unescaped '@' is masked whole.
    const at = authority.lastIndexOf('@');
    if (at === -1) return url;
    return `${url.slice(0, authorityStart)}***@${rest.slice(at + 1)}`;
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
        return {
            ok: false,
            reason: 'the broker URL cannot be parsed (a password with /, # or ? must be percent-encoded)',
        };
    }
    const scheme = parsed.protocol.replace(/:$/, '');
    if (!SUPPORTED_SCHEMES.has(scheme)) {
        return { ok: false, reason: `unsupported scheme "${scheme}" (use mqtt, mqtts, ws or wss)` };
    }
    if (parsed.hostname === '') return { ok: false, reason: 'the broker URL has no host' };
    return { ok: true, url, display: `${scheme}://${parsed.host}` };
}
