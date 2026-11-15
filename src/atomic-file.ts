import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Crash-safe file replacement: the data goes to a temporary file in the same
 * directory (same filesystem, so `rename` is atomic), is flushed to disk and
 * only then renamed over the target. A power cut or crash mid-write leaves
 * either the old file or the new one, never a truncated one — which matters
 * for `config.json`, where a truncated file stops the whole of Homebridge.
 *
 * - A symlinked target is written through: the link stays, its destination is replaced.
 * - The target's permission bits (and owner, when allowed) are kept; a file
 *   created for the first time is `0600`, because these files hold the
 *   installation's state (and `config.json` its PIN).
 * - The temporary file is created exclusively, with an unpredictable name.
 */
export interface AtomicWriteOptions {
    /** Permission bits for the new file. Default: the existing file's, else `0600`. */
    mode?: number;
    /**
     * Called when the temporary file cannot be created or renamed (for example
     * `config.json` bind-mounted as a single file in a container, where `rename`
     * fails with `EBUSY`). Its presence allows the write to fall back to
     * rewriting the file in place — not crash-safe, so the caller must tell the
     * user. Without it the error is thrown.
     */
    onInPlaceFallback?: (reason: NodeJS.ErrnoException) => void;
    /** Filesystem primitives, replaceable in tests (defaults to `fs.promises`). */
    fileSystem?: Partial<AtomicFileSystem>;
}

export interface AtomicWriteResult {
    /** `rename`: replaced atomically. `in-place`: rewritten in place after a fallback. */
    method: 'rename' | 'in-place';
    /** The file actually written (the symlink's destination, when the target is a link). */
    path: string;
}

export interface AtomicFileSystem {
    realpath(target: string): Promise<string>;
    stat(target: string): Promise<{ mode: number; uid: number; gid: number }>;
    open(target: string, flags: string, mode?: number): Promise<fs.promises.FileHandle>;
    rename(from: string, to: string): Promise<void>;
    unlink(target: string): Promise<void>;
}

/** Late-bound, so that a test replacing `fs.promises.rename` is honoured. */
const defaultFileSystem: AtomicFileSystem = {
    realpath: (target) => fs.promises.realpath(target),
    stat: (target) => fs.promises.stat(target),
    open: (target, flags, mode) => fs.promises.open(target, flags, mode),
    rename: (from, to) => fs.promises.rename(from, to),
    unlink: (target) => fs.promises.unlink(target),
};

/** Errors for which rewriting in place is a sensible alternative to the temp-and-rename scheme. */
const FALLBACK_CODES = new Set(['EBUSY', 'EXDEV', 'EACCES', 'EPERM']);

const TEMPORARY_ATTEMPTS = 5;
const PERMISSION_BITS = 0o777;

function temporaryPathFor(filePath: string): string {
    return `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

async function resolveTarget(fileSystem: AtomicFileSystem, filePath: string): Promise<string> {
    try {
        return await fileSystem.realpath(filePath);
    } catch (error: unknown) {
        // Not there yet (or not resolvable): a new file at the given path.
        if (errorCode(error) === 'ENOENT') return filePath;
        throw error;
    }
}

async function openTemporary(
    fileSystem: AtomicFileSystem,
    targetPath: string,
    mode: number,
): Promise<{ handle: fs.promises.FileHandle; temporaryPath: string }> {
    for (let attempt = 1; ; attempt += 1) {
        const temporaryPath = temporaryPathFor(targetPath);
        try {
            return { handle: await fileSystem.open(temporaryPath, 'wx', mode), temporaryPath };
        } catch (error: unknown) {
            if (errorCode(error) !== 'EEXIST' || attempt >= TEMPORARY_ATTEMPTS) throw error;
        }
    }
}

async function writeAndSync(
    handle: fs.promises.FileHandle,
    data: string,
    mode: number,
    owner: { uid: number; gid: number } | undefined,
): Promise<void> {
    await handle.writeFile(data, 'utf8');
    await handle.chmod(mode);
    // Keeping the owner needs privileges: without them the file stays the process's.
    if (owner) await handle.chown(owner.uid, owner.gid).catch(() => undefined);
    await handle.sync();
}

/** Best effort: makes the rename itself durable. */
async function syncDirectory(fileSystem: AtomicFileSystem, directory: string): Promise<void> {
    try {
        const handle = await fileSystem.open(directory, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Not supported on every platform or filesystem.
    }
}

async function rewriteInPlace(fileSystem: AtomicFileSystem, targetPath: string, data: string, mode: number): Promise<void> {
    const handle = await fileSystem.open(targetPath, 'w', mode);
    try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export async function writeFileAtomic(
    filePath: string,
    data: string,
    options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
    const fileSystem: AtomicFileSystem = { ...defaultFileSystem, ...options.fileSystem };
    const targetPath = await resolveTarget(fileSystem, filePath);
    const existing = await fileSystem.stat(targetPath).catch(() => undefined);
    const mode = options.mode ?? (existing ? existing.mode & PERMISSION_BITS : 0o600);
    let temporaryPath: string | undefined;
    try {
        const temporary = await openTemporary(fileSystem, targetPath, mode);
        temporaryPath = temporary.temporaryPath;
        try {
            await writeAndSync(temporary.handle, data, mode, existing);
        } finally {
            await temporary.handle.close();
        }
        await fileSystem.rename(temporaryPath, targetPath);
        temporaryPath = undefined;
        await syncDirectory(fileSystem, path.dirname(targetPath));
        return { method: 'rename', path: targetPath };
    } catch (error: unknown) {
        if (temporaryPath) await fileSystem.unlink(temporaryPath).catch(() => undefined);
        const code = errorCode(error);
        if (!options.onInPlaceFallback || !code || !FALLBACK_CODES.has(code) || !existing) throw error;
        options.onInPlaceFallback(error as NodeJS.ErrnoException);
        await rewriteInPlace(fileSystem, targetPath, data, mode);
        return { method: 'in-place', path: targetPath };
    }
}

function resolveTargetSync(filePath: string): string {
    try {
        return fs.realpathSync(filePath);
    } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return filePath;
        throw error;
    }
}

function openTemporarySync(targetPath: string, mode: number): { fd: number; temporaryPath: string } {
    for (let attempt = 1; ; attempt += 1) {
        const temporaryPath = temporaryPathFor(targetPath);
        try {
            return { fd: fs.openSync(temporaryPath, 'wx', mode), temporaryPath };
        } catch (error: unknown) {
            if (errorCode(error) !== 'EEXIST' || attempt >= TEMPORARY_ATTEMPTS) throw error;
        }
    }
}

export function writeFileAtomicSync(filePath: string, data: string, options: AtomicWriteOptions = {}): AtomicWriteResult {
    const targetPath = resolveTargetSync(filePath);
    let existing: fs.Stats | undefined;
    try {
        existing = fs.statSync(targetPath);
    } catch {
        existing = undefined;
    }
    const mode = options.mode ?? (existing ? existing.mode & PERMISSION_BITS : 0o600);
    const { fd, temporaryPath } = openTemporarySync(targetPath, mode);
    try {
        try {
            fs.writeFileSync(fd, data, 'utf8');
            fs.fchmodSync(fd, mode);
            if (existing) {
                try {
                    fs.fchownSync(fd, existing.uid, existing.gid);
                } catch {
                    // Keeping the owner needs privileges.
                }
            }
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporaryPath, targetPath);
    } catch (error: unknown) {
        try {
            fs.unlinkSync(temporaryPath);
        } catch {
            // Nothing to clean up.
        }
        throw error;
    }
    return { method: 'rename', path: targetPath };
}

/** Serializes first, so a value that cannot be serialized never touches the disk. */
export function writeJsonAtomic(filePath: string, value: unknown, indent: number | string = 2): Promise<AtomicWriteResult> {
    return writeFileAtomic(filePath, JSON.stringify(value, null, indent));
}

export function writeJsonAtomicSync(filePath: string, value: unknown, indent: number | string = 2): AtomicWriteResult {
    return writeFileAtomicSync(filePath, JSON.stringify(value, null, indent));
}

/**
 * Temporary files are named `<file>.<pid>.<random>.tmp` (earlier versions used a
 * counter instead of the random part). A crash between creating and renaming one
 * leaves it behind — for `config.json` with the PIN inside.
 */
const TEMPORARY_FILE = /^(config\.json|klares4-[A-Za-z0-9._-]+?)\.\d+\.(?:[0-9a-f]{12}|\d+)\.tmp$/;

function isTemporaryFileOf(baseName: string, entry: string): boolean {
    const prefix = `${baseName}.`;
    return entry.startsWith(prefix) && /^\d+\.(?:[0-9a-f]{12}|\d+)\.tmp$/.test(entry.slice(prefix.length));
}

export interface OrphanCleanupOptions {
    /**
     * Clean only temporary files of these exact file names (for a symlinked file the
     * temporary file is created next to its destination, in another directory).
     * Default: the plugin's own file names.
     */
    baseNames?: readonly string[];
    /** Only files untouched for this long are removed: a write in progress is never that old. Default 5 minutes. */
    minAgeMs?: number;
    now?: () => number;
}

/** Removes the plugin's own stale temporary files from `directory`; returns the names removed. */
export async function removeOrphanedTemporaryFiles(directory: string, options: OrphanCleanupOptions = {}): Promise<string[]> {
    const minAgeMs = options.minAgeMs ?? 5 * 60 * 1000;
    const now = (options.now ?? Date.now)();
    const removed: string[] = [];
    let names: string[];
    try {
        names = await fs.promises.readdir(directory);
    } catch {
        return removed;
    }
    const { baseNames } = options;
    const isOurs = baseNames
        ? (entry: string): boolean => baseNames.some((base) => isTemporaryFileOf(base, entry))
        : (entry: string): boolean => TEMPORARY_FILE.test(entry);
    for (const name of names.filter(isOurs)) {
        const target = path.join(directory, name);
        try {
            const stats = await fs.promises.lstat(target);
            if (!stats.isFile() || now - stats.mtimeMs < minAgeMs) continue;
            await fs.promises.unlink(target);
            removed.push(name);
        } catch {
            // Gone already, or not ours to remove.
        }
    }
    return removed;
}
