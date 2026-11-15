import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import { removeOrphanedTemporaryFiles, writeFileAtomic, type AtomicFileSystem } from '../atomic-file';
import { PLUGIN_NAME } from '../settings';
import { toErrorMessage } from '../errors';

type PlatformBlock = Record<string, unknown> & { platform?: string; name?: unknown; ip?: unknown };

interface StoredConfigFile {
    platforms?: PlatformBlock[];
}

/** Homebridge (and its UI) write config.json with a 4-space indent and a trailing newline. */
const DEFAULT_INDENT = '    ';

/** The indentation the file already uses, so a rewrite changes only the edited keys. */
function detectIndent(content: string): string {
    const match = /^\{\r?\n([ \t]+)\S/.exec(content);
    return match?.[1] ?? DEFAULT_INDENT;
}

/** What tells this instance's platform block apart when config.json holds more than one. */
export interface PlatformBlockSelector {
    name?: string;
    ip?: string;
}

/**
 * What an update did. `written`: config.json now holds the change.
 * `unchanged`: nothing needed changing. The rest are failures to apply it —
 * the caller must not report success for them.
 */
export interface ConfigUpdateOutcome {
    status: 'written' | 'unchanged' | 'no-platform-block' | 'ambiguous' | 'failed';
    /** `in-place`: the file could not be replaced atomically and was rewritten where it is. */
    method?: 'rename' | 'in-place';
    error?: string;
}

function sameText(left: unknown, right: string | undefined): boolean {
    return right !== undefined && typeof left === 'string' && left.trim() === right.trim();
}

/** The one block that is this instance, or undefined when there is none or it cannot be told. */
function chooseBlock(matches: PlatformBlock[], selector: PlatformBlockSelector | undefined): PlatformBlock | undefined {
    if (matches.length <= 1) return matches[0];
    const byName = matches.filter((block) => sameText(block.name, selector?.name));
    if (byName.length === 1) return byName[0];
    const byIp = (byName.length > 1 ? byName : matches).filter((block) => sameText(block.ip, selector?.ip));
    return byIp.length === 1 ? byIp[0] : undefined;
}

export class PlatformConfigFileService {
    /** Read-modify-write cycles run one at a time, so two updates cannot overwrite each other. */
    private pending: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly log: Logger,
        private readonly storagePath: string,
        /** Filesystem primitives of the atomic write, replaceable in tests. */
        private readonly fileSystem?: Partial<AtomicFileSystem>,
    ) {}

    /** Removes temporary files an earlier crash left in the storage directory (they may hold the PIN). */
    public async removeOrphanedTemporaryFiles(): Promise<void> {
        const removed = await removeOrphanedTemporaryFiles(this.storagePath);
        // A symlinked config.json is written through: its temporary file lives next to the destination.
        const destination = await fs.promises.realpath(path.join(this.storagePath, 'config.json')).catch(() => undefined);
        if (destination && path.dirname(destination) !== path.resolve(this.storagePath)) {
            removed.push(...await removeOrphanedTemporaryFiles(path.dirname(destination), { baseNames: [path.basename(destination)] }));
        }
        if (removed.length > 0) this.log.info(`Removed ${removed.length} leftover temporary file(s) from the Homebridge storage directory`);
    }

    public async disableDebugFlag(platformName: string, selector?: PlatformBlockSelector): Promise<ConfigUpdateOutcome> {
        const outcome = await this.updatePlatformConfig(platformName, (platformConfig) => {
            if (!platformConfig.generateDebugFile) return false;
            platformConfig.generateDebugFile = false;
            return true;
        }, selector);
        if (outcome.status === 'written') this.log.info('Debug flag disabled in config.json');
        else if (outcome.status !== 'unchanged') {
            this.log.warn('The debug flag could not be switched off in config.json: the debug capture will run again at the next start');
        }
        return outcome;
    }

    public updatePlatformConfig(
        platformName: string,
        updater: (platformConfig: Record<string, unknown>) => boolean,
        selector?: PlatformBlockSelector,
    ): Promise<ConfigUpdateOutcome> {
        const run = this.pending.then(() => this.applyUpdate(platformName, updater, selector));
        this.pending = run;
        return run;
    }

    private async applyUpdate(
        platformName: string,
        updater: (platformConfig: Record<string, unknown>) => boolean,
        selector: PlatformBlockSelector | undefined,
    ): Promise<ConfigUpdateOutcome> {
        try {
            const configPath = path.join(this.storagePath, 'config.json');
            const configContent = await fs.promises.readFile(configPath, 'utf8');
            const configData = JSON.parse(configContent) as StoredConfigFile;

            // Homebridge 2.x also accepts the fully qualified "<plugin>.<platform>" identifier.
            const qualifiedName = `${PLUGIN_NAME}.${platformName}`;
            const matches = (configData.platforms ?? []).filter(
                (platformEntry) => platformEntry.platform === platformName || platformEntry.platform === qualifiedName,
            );
            if (matches.length === 0) {
                this.log.warn(`config.json has no "${platformName}" platform block: nothing was changed`);
                return { status: 'no-platform-block' };
            }
            const platformConfig = chooseBlock(matches, selector);
            if (!platformConfig) {
                this.log.warn(
                    `config.json has ${matches.length} "${platformName}" blocks and none can be told apart as this instance `
                    + '(by "name" or "ip"): nothing was changed. Keep a single block, or give each a distinct name.',
                );
                return { status: 'ambiguous' };
            }
            if (!updater(platformConfig)) return { status: 'unchanged' };

            const trailingNewline = configContent.length === 0 || /\n$/.test(configContent) ? '\n' : '';
            const serialized = JSON.stringify(configData, null, detectIndent(configContent)) + trailingNewline;
            const result = await writeFileAtomic(configPath, serialized, {
                fileSystem: this.fileSystem,
                onInPlaceFallback: (reason): void => this.log.warn(
                    `config.json could not be replaced atomically (${reason.code}); rewriting it in place. `
                    + 'A crash during the write could corrupt it: keep a backup.',
                ),
            });
            return { status: 'written', method: result.method };
        } catch (error: unknown) {
            const message = toErrorMessage(error);
            this.log.error('Failed to update config.json:', message);
            return { status: 'failed', error: message };
        }
    }
}
