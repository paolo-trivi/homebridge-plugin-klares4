import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';

interface StoredConfigFile {
    platforms?: Array<Record<string, unknown> & { platform?: string; generateDebugFile?: boolean }>;
}

export class PlatformConfigFileService {
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

    public async updatePlatformConfig(
        platformName: string,
        updater: (platformConfig: Record<string, unknown>) => boolean,
    ): Promise<void> {
        try {
            const configPath = path.join(this.storagePath, 'config.json');
            const configContent = await fs.promises.readFile(configPath, 'utf8');
            const configData = JSON.parse(configContent) as StoredConfigFile;

            const platformConfig = configData.platforms?.find(
                (platformEntry) => platformEntry.platform === platformName,
            );
            if (platformConfig && updater(platformConfig)) {
                await fs.promises.writeFile(configPath, JSON.stringify(configData, null, 4), 'utf8');
            }
        } catch (error: unknown) {
            this.log.error(
                'Failed to update config.json:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
