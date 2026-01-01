/**
 * Log level definitions for the Ksenia Lares4 plugin
 * 
 * Levels:
 * - MINIMAL (0): Only errors, warnings, and critical events (zone alarms)
 * - NORMAL (1): Standard operation logs, startup summary, commands
 * - DEBUG (2): Full verbose logging for troubleshooting
 */
export enum LogLevel {
    MINIMAL = 0,
    NORMAL = 1,
    DEBUG = 2,
}

/**
 * Masks sensitive data in log messages (e.g., PIN codes)
 * @param message The message potentially containing sensitive data
 * @returns The message with sensitive data masked
 */
export function maskSensitiveData(message: string): string {
    // Mask PIN in JSON-like structures: "PIN":"123456" -> "PIN":"***"
    return message.replace(/"PIN"\s*:\s*"[^"]*"/gi, '"PIN":"***"');
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
