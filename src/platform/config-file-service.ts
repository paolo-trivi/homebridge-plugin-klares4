import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';

interface StoredConfigFile {
    platforms?: Array<{ platform?: string; generateDebugFile?: boolean }>;
}

export class PlatformConfigFileService {
    constructor(
        private readonly log: Logger,
        private readonly storagePath: string,
    ) {}

    public async disableDebugFlag(platformName: string): Promise<void> {
        try {
            const configPath = path.join(this.storagePath, 'config.json');
            const configContent = await fs.promises.readFile(configPath, 'utf8');
            const configData = JSON.parse(configContent) as StoredConfigFile;

            const platformConfig = configData.platforms?.find(
                (platformEntry) => platformEntry.platform === platformName,
            );
            if (platformConfig?.generateDebugFile) {
                platformConfig.generateDebugFile = false;
                await fs.promises.writeFile(configPath, JSON.stringify(configData, null, 4), 'utf8');
                this.log.info('Debug flag disabled in config.json');
            }
        } catch (error: unknown) {
            this.log.error(
                'Failed to disable debug flag:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
