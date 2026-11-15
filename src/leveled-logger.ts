import type { Logger } from 'homebridge';

import { LogLevel } from './log-levels';

/** Homebridge's level names, as `Logger.log(level, ...)` receives them. */
type HomebridgeLevel = Parameters<Logger['log']>[0];

/** Marks a plugin debug line shown through Homebridge's info level. */
const DEBUG_MARK = '[debug]';

/**
 * The plugin's logger: Homebridge's logger held to the configured `logLevel`.
 *
 * - Warnings and errors always go through.
 * - `info` (and `success`) lines are dropped at MINIMAL.
 * - `debug` lines go to Homebridge's debug level, which Homebridge shows only
 *   in its own debug mode (`-D`); at DEBUG they are written at info level,
 *   marked `[debug]`, so the plugin's trace does not require running the whole
 *   of Homebridge in debug mode.
 *
 * Every module logs through the object it is given, so wrapping the logger
 * once, in the platform, is what makes the level apply everywhere.
 */
export function createLeveledLogger(log: Logger, level: LogLevel): Logger {
    const info = (message: string, ...parameters: unknown[]): void => {
        if (level >= LogLevel.NORMAL) log.info(message, ...parameters);
    };
    const debug = (message: string, ...parameters: unknown[]): void => {
        if (level >= LogLevel.DEBUG) log.info(`${DEBUG_MARK} ${message}`, ...parameters);
        else log.debug(message, ...parameters);
    };
    const warn = (message: string, ...parameters: unknown[]): void => log.warn(message, ...parameters);
    const error = (message: string, ...parameters: unknown[]): void => log.error(message, ...parameters);
    const success = (message: string, ...parameters: unknown[]): void => {
        if (level < LogLevel.NORMAL) return;
        // A logger without `success` (older Homebridge, test doubles) still gets the line.
        if (typeof log.success === 'function') log.success(message, ...parameters);
        else log.info(message, ...parameters);
    };
    const byLevel: Record<string, (message: string, ...parameters: unknown[]) => void> = { info, success, warn, error, debug };

    return {
        get prefix(): string | undefined {
            return log.prefix;
        },
        info,
        success,
        warn,
        error,
        debug,
        log: (homebridgeLevel: HomebridgeLevel, message: string, ...parameters: unknown[]): void => {
            (byLevel[String(homebridgeLevel)] ?? info)(message, ...parameters);
        },
    };
}
