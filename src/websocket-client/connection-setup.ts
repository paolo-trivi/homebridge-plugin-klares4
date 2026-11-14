import * as https from 'https';
import * as crypto from 'crypto';
import type { WebSocketConnectionOptions } from './types';

/**
 * Largest frame accepted from the panel. Real frames are tens of kB (the
 * biggest seen, CFG_THERMOSTATS, about 41 kB); without a limit `ws` accepts
 * 100 MiB and parses it synchronously. A bigger frame closes the socket
 * (1009) and the session reconnects.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** WebSocket URL of the panel; an IPv6 literal goes in brackets. */
export function panelUrl(ip: string, port: number, useHttps: boolean): string {
    const protocol = useHttps ? 'wss' : 'ws';
    const host = ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
    return `${protocol}://${host}:${port}/KseniaWsock/`;
}

export function connectionOptions(
    useHttps: boolean,
    allowInsecureTls: boolean,
    maxPayload: number,
): WebSocketConnectionOptions {
    const wsOptions: WebSocketConnectionOptions = {
        rejectUnauthorized: !allowInsecureTls,
        maxPayload,
    };

    if (useHttps && allowInsecureTls) {
        // Node.js 24 ships an OpenSSL build that refuses unsafe legacy
        // renegotiation by default. The Lares4 panel still requires it
        // (`SSL_OP_LEGACY_SERVER_CONNECT` is not enough — see error
        // `unsafe legacy renegotiation disabled` from
        // ssl/statem/extensions.c:893). Enabling both flags restores
        // compatibility on Node 20–24.
        wsOptions.agent = new https.Agent({
            rejectUnauthorized: false,
            secureOptions:
                crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
                | crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION,
            secureProtocol: 'TLS_method',
            ciphers: 'ALL:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA',
        });
    }
    return wsOptions;
}
