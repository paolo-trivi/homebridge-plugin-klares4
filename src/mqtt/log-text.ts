const MAX_LOGGED_CHARS = 80;

/**
 * Renders text that came from the network (topic levels, payload keys) for a
 * log line: quoted and escaped by `JSON.stringify`, so a newline cannot start
 * a forged log line, and cut to a fixed length.
 */
export function logText(value: string): string {
    if (value.length <= MAX_LOGGED_CHARS) return JSON.stringify(value);
    return `${JSON.stringify(value.slice(0, MAX_LOGGED_CHARS))}... (${value.length} chars)`;
}
