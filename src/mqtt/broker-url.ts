// scheme://[userinfo@]host... — the greedy authority match stops at the last
// '@' before the path, so a password with an unescaped '@' is masked whole.
const USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

/** Replaces `user:password@` in a broker URL with `***@`, for logging. */
export function maskBrokerUrl(brokerUrl: string): string {
    return brokerUrl.replace(USERINFO_PATTERN, '$1***@');
}
