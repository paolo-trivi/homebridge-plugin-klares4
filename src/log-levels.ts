/**
 * Log level definitions for the Ksenia Lares4 plugin
 * 
 * Levels:
 * - MINIMAL (0): Only errors, warnings, and critical events (zone alarms)
 * - NORMAL (1): Standard operation logs, startup summary, commands
 * - DEBUG (2): Full verbose logging for troubleshooting
 */
import { isCredentialKey } from './secret-keys';

export enum LogLevel {
    MINIMAL = 0,
    NORMAL = 1,
    DEBUG = 2,
}

/** A JSON key, and the same key inside a JSON text carried as a string (`"PAYLOAD":"{\"PIN\":...}"`). */
const PLAIN_KEY = /(?<!\\)"([^"\\]*)"\s*:\s*/g;
const ESCAPED_KEY = /\\"([^"\\]*)\\"\s*:\s*/g;

/**
 * Masks sensitive data in log messages (e.g., PIN codes).
 * The value of every credential key gets `"***"`, whatever its JSON type: a
 * string with escaped quotes or backslashes, a number, a literal, an array or
 * an object is replaced whole, also in a truncated frame and in a payload
 * carried as a JSON string, so no fragment of it is left behind.
 * @param message The message potentially containing sensitive data
 * @returns The message with sensitive data masked
 */
export function maskSensitiveData(message: string): string {
    return maskKeys(maskKeys(message, PLAIN_KEY, '"'), ESCAPED_KEY, '\\"');
}

function maskKeys(text: string, keyPattern: RegExp, quote: string): string {
    let masked = '';
    let cursor = 0;
    keyPattern.lastIndex = 0;
    for (let match = keyPattern.exec(text); match !== null; match = keyPattern.exec(text)) {
        if (!isCredentialKey(match[1])) continue;
        const valueEnd = endOfValue(text, keyPattern.lastIndex, quote);
        masked += `${text.slice(cursor, match.index)}${quote}${match[1]}${quote}:${quote}***${quote}`;
        cursor = valueEnd;
        keyPattern.lastIndex = valueEnd;
    }
    return masked + text.slice(cursor);
}

/** Index just past the value starting at `start` (end of text when it is truncated). */
function endOfValue(text: string, start: number, quote: string): number {
    if (text.startsWith(quote, start)) return endOfString(text, start + quote.length, quote);
    const first = text[start];
    if (first === '{' || first === '[') {
        let depth = 0;
        for (let i = start; i < text.length;) {
            if (text.startsWith(quote, i)) {
                i = endOfString(text, i + quote.length, quote);
                continue;
            }
            const ch = text[i];
            if (ch === '{' || ch === '[') depth += 1;
            else if ((ch === '}' || ch === ']') && --depth === 0) return i + 1;
            i += 1;
        }
        return text.length;
    }
    let end = start;
    while (end < text.length && !/[,}\]\s\\]/.test(text[end])) end += 1;
    return end;
}

/**
 * Index just past the closing quote of a string whose content starts at `from`.
 * In a JSON text carried as a string, a backslash of the inner text appears as
 * `\\` and escapes the next unit, and the closing quote appears as `\"`.
 */
function endOfString(text: string, from: number, quote: string): number {
    for (let i = from; i < text.length;) {
        if (quote === '"') {
            if (text[i] === '\\') i += 2;
            else if (text[i] === '"') return i + 1;
            else i += 1;
        } else if (text.startsWith('\\\\', i)) {
            i += 2;
            i += text[i] === '\\' ? 2 : 1;
        } else if (text.startsWith('\\"', i)) {
            return i + 2;
        } else {
            i += 1;
        }
    }
    return text.length;
}

/**
 * Get effective log level from configuration
 * Maintains backward compatibility with `debug: true`
 * @param logLevel The configured logLevel (0, 1, or 2)
 * @param debug The legacy debug flag
 * @returns The effective log level
 */
export function getEffectiveLogLevel(logLevel?: number, debug?: boolean): LogLevel {
    // If logLevel is explicitly set, use it
    if (typeof logLevel === 'number' && logLevel >= 0 && logLevel <= 2) {
        return logLevel as LogLevel;
    }
    // Backward compatibility: debug: true = DEBUG level
    if (debug === true) {
        return LogLevel.DEBUG;
    }
    // Default to NORMAL
    return LogLevel.NORMAL;
}
