import * as fs from 'fs';

/**
 * Crash-safe file replacement: the data goes to a temporary file in the same
 * directory (same filesystem, so `rename` is atomic), is flushed to disk and
 * only then renamed over the target. A power cut or crash mid-write leaves
 * either the old file or the new one, never a truncated one — which matters
 * for `config.json`, where a truncated file stops the whole of Homebridge.
 *
 * The target's current permission bits are kept (a `config.json` restricted
 * to 0600 because it holds the panel PIN stays 0600).
 */
export interface AtomicWriteOptions {
    /** Permission bits for the new file. Default: the existing file's, else the process default. */
    mode?: number;
}

let temporarySequence = 0;

function temporaryPathFor(filePath: string): string {
    temporarySequence += 1;
    return `${filePath}.${process.pid}.${temporarySequence}.tmp`;
}

async function existingMode(filePath: string): Promise<number | undefined> {
    try {
        return (await fs.promises.stat(filePath)).mode & 0o777;
    } catch {
        return undefined;
    }
}

function existingModeSync(filePath: string): number | undefined {
    try {
        return fs.statSync(filePath).mode & 0o777;
    } catch {
        return undefined;
    }
}

export async function writeFileAtomic(filePath: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
    const mode = options.mode ?? (await existingMode(filePath));
    const temporaryPath = temporaryPathFor(filePath);
    try {
        const handle = await fs.promises.open(temporaryPath, 'w', mode ?? 0o666);
        try {
            await handle.writeFile(data, 'utf8');
            if (mode !== undefined) await handle.chmod(mode);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.promises.rename(temporaryPath, filePath);
    } catch (error: unknown) {
        await fs.promises.unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

export function writeFileAtomicSync(filePath: string, data: string, options: AtomicWriteOptions = {}): void {
    const mode = options.mode ?? existingModeSync(filePath);
    const temporaryPath = temporaryPathFor(filePath);
    try {
        const fd = fs.openSync(temporaryPath, 'w', mode ?? 0o666);
        try {
            fs.writeFileSync(fd, data, 'utf8');
            if (mode !== undefined) fs.fchmodSync(fd, mode);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporaryPath, filePath);
    } catch (error: unknown) {
        try {
            fs.unlinkSync(temporaryPath);
        } catch {
            // Nothing to clean up.
        }
        throw error;
    }
}

/** Serializes first, so a value that cannot be serialized never touches the disk. */
export function writeJsonAtomic(filePath: string, value: unknown, indent: number | string = 2): Promise<void> {
    return writeFileAtomic(filePath, JSON.stringify(value, null, indent));
}

export function writeJsonAtomicSync(filePath: string, value: unknown, indent: number | string = 2): void {
    writeFileAtomicSync(filePath, JSON.stringify(value, null, indent));
}
