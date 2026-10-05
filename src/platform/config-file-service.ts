import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';
import { writeFileAtomic } from '../atomic-file';
import { PLUGIN_NAME } from '../settings';

interface StoredConfigFile {
    platforms?: Array<Record<string, unknown> & { platform?: string; generateDebugFile?: boolean }>;
}

/** Homebridge (and its UI) write config.json with a 4-space indent and a trailing newline. */
const DEFAULT_INDENT = '    ';

/** The indentation the file already uses, so a rewrite changes only the edited keys. */
function detectIndent(content: string): string {
    const match = /^\{\r?\n([ \t]+)\S/.exec(content);
    return match ? match[1] : DEFAULT_INDENT;
}

export class PlatformConfigFileService {
    /** Read-modify-write cycles run one at a time, so two updates cannot overwrite each other. */
    private pending: Promise<void> = Promise.resolve();

    constructor(
        private readonly log: Logger,
        private readonly storagePath: string,
    ) {}

    public async disableDebugFlag(platformName: string): Promise<void> {
        await this.updatePlatformConfig(platformName, (platformConfig) => {
            if (platformConfig.generateDebugFile) {
                platformConfig.generateDebugFile = false;
                this.log.info('Debug flag disabled in config.json');
                return true;
            }
            return false;
        });
    }

    public updatePlatformConfig(
        platformName: string,
        updater: (platformConfig: Record<string, unknown>) => boolean,
    ): Promise<void> {
        const run = this.pending.then(() => this.applyUpdate(platformName, updater));
        this.pending = run.catch(() => undefined);
        return run;
    }

    private async applyUpdate(
        platformName: string,
        updater: (platformConfig: Record<string, unknown>) => boolean,
    ): Promise<void> {
        try {
            const configPath = path.join(this.storagePath, 'config.json');
            const configContent = await fs.promises.readFile(configPath, 'utf8');
            const configData = JSON.parse(configContent) as StoredConfigFile;

            // Homebridge 2.x also accepts the fully qualified "<plugin>.<platform>" identifier.
            const qualifiedName = `${PLUGIN_NAME}.${platformName}`;
            const platformConfig = configData.platforms?.find(
                (platformEntry) => platformEntry.platform === platformName || platformEntry.platform === qualifiedName,
            );
            if (platformConfig && updater(platformConfig)) {
                const trailingNewline = configContent.length === 0 || /\n$/.test(configContent) ? '\n' : '';
                const serialized = JSON.stringify(configData, null, detectIndent(configContent)) + trailingNewline;
                await writeFileAtomic(configPath, serialized);
            }
        } catch (error: unknown) {
            this.log.error(
                'Failed to update config.json:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
