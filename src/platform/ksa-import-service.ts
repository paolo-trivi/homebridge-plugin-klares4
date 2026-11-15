import * as fs from 'fs';
import type { Logger } from 'homebridge';
import { KsaCacheService } from '../ksa/cache-service';
import { deriveKsaImportResult } from '../ksa/derive';
import { assertKsaFileSize, parseKsaProgramFromBuffer } from '../ksa/parser';
import type { KsaImportResult } from '../ksa/types';
import type { KsaSanitizedCache } from '../types';
import type { PlatformBlockSelector, PlatformConfigFileService } from './config-file-service';
import type { Lares4Config } from './types';
import { mergeCustomNames, type CustomNamesConfig } from './custom-names-config';
import { existingRows, planPairMerge, resolveKsaRoomMapping, type PairMergePlan } from './ksa-config-merge';
import { toErrorMessage } from '../errors';

export class KsaImportService {
    private readonly cacheService: KsaCacheService;

    constructor(
        private readonly log: Logger,
        storagePath: string,
        private readonly configFileService: PlatformConfigFileService,
    ) {
        this.cacheService = new KsaCacheService(storagePath, log);
    }

    public async prepare(config: Lares4Config, platformName: string): Promise<KsaSanitizedCache | undefined> {
        const importConfig = config.ksaImport;
        if (!importConfig?.enabled) {
            return this.cacheService.load();
        }

        const filePath = importConfig.filePath?.trim();
        if (!filePath) {
            this.log.warn('KSA import enabled but filePath is missing. Using existing cache if available.');
            return this.cacheService.load();
        }

        try {
            assertKsaFileSize((await fs.promises.stat(filePath)).size);
            const raw = await fs.promises.readFile(filePath);
            const program = parseKsaProgramFromBuffer(raw);
            const result = deriveKsaImportResult(program, filePath, raw);
            await this.cacheService.save(result.cache);
            this.logPreview(result);
            this.applyRuntimeConfig(config, result);

            if (importConfig.applyAtStartup) {
                await this.persistAppliedConfig(platformName, result, config);
            }
            return result.cache;
        } catch (error: unknown) {
            this.log.error(`KSA import failed (${filePath}): ${toErrorMessage(error)}`);
            return this.cacheService.load();
        }
    }

    private applyRuntimeConfig(config: Lares4Config, result: KsaImportResult): void {
        const importConfig = config.ksaImport ?? {};
        if (importConfig.applyDomusMappings !== false) {
            const derived = result.derivedConfig.domusThermostat;
            const manualPairs = planPairMerge(config.domusThermostat?.manualPairs, derived.manualPairs, 'domusSensorId');
            const manualCommandPairs = planPairMerge(
                config.domusThermostat?.manualCommandPairs, derived.manualCommandPairs, 'commandThermostatId',
            );
            this.logKeptPairs('manualPairs', manualPairs);
            this.logKeptPairs('manualCommandPairs', manualCommandPairs);
            // The user's pairs stay as they are; the backup only adds the missing ones.
            config.domusThermostat = {
                ...(config.domusThermostat ?? {}),
                ...(manualPairs.additions.length > 0
                    ? { manualPairs: [...(config.domusThermostat?.manualPairs ?? []), ...manualPairs.additions] }
                    : {}),
                ...(manualCommandPairs.additions.length > 0
                    ? { manualCommandPairs: [...(config.domusThermostat?.manualCommandPairs ?? []), ...manualCommandPairs.additions] }
                    : {}),
            };
        }

        if (importConfig.applyRoomMapping !== false) {
            const roomMapping = resolveKsaRoomMapping(config.roomMapping, result.derivedConfig.roomMapping.rooms ?? []);
            if (roomMapping) config.roomMapping = roomMapping;
        }

        if (importConfig.applyCustomNames) {
            // Per device, the user's own name wins over the panel's.
            config.customNames = mergeCustomNames(config.customNames, result.derivedConfig.customNames);
        }

        if (importConfig.applyExclusionSuggestions) {
            this.log.info(
                'ksaImport.applyExclusionSuggestions is ignored: devices the plugin does not expose by default are '
                + 'already hidden, and your exclude* lists are never changed by the import.',
            );
        }
    }

    private logKeptPairs(listName: string, plan: PairMergePlan<unknown>): void {
        for (const conflict of plan.conflicts) {
            this.log.info(
                `KSA import: keeping your domusThermostat.${listName} entry for thermostat_${conflict.outputId} `
                + `(${conflict.kept}); the backup has ${conflict.backup}`,
            );
        }
    }

    private async persistAppliedConfig(
        platformName: string,
        result: KsaImportResult,
        config: Lares4Config,
    ): Promise<void> {
        const selector: PlatformBlockSelector = { name: config.name, ip: config.ip };
        const outcome = await this.configFileService.updatePlatformConfig(platformName, (platformConfig) => {
            const importConfig = (platformConfig.ksaImport as Record<string, unknown> | undefined) ?? {};
            const applyDomusMappings = importConfig.applyDomusMappings !== false;
            const applyRoomMapping = importConfig.applyRoomMapping !== false;
            const applyCustomNames = importConfig.applyCustomNames === true;

            if (applyDomusMappings) this.persistDomusPairs(platformConfig, result);
            if (applyRoomMapping) {
                const roomMapping = resolveKsaRoomMapping(
                    platformConfig.roomMapping,
                    result.derivedConfig.roomMapping.rooms ?? [],
                );
                if (roomMapping) platformConfig.roomMapping = roomMapping;
            }
            if (applyCustomNames) {
                // Array form: the Homebridge UI drops the category map on its next save.
                platformConfig.customNames = mergeCustomNames(
                    platformConfig.customNames as CustomNamesConfig | undefined,
                    result.derivedConfig.customNames,
                );
            }

            platformConfig.ksaImport = {
                ...importConfig,
                applyAtStartup: false,
            };
            return true;
        }, selector);

        if (outcome.status !== 'written') {
            // Left as it is: the import is applied again at the next start, nothing is lost.
            this.log.warn(
                `KSA import was applied for this run but could not be saved to config.json (${outcome.status}); `
                + 'applyAtStartup stays on and the import will run again at the next start.',
            );
            return;
        }
        config.ksaImport = {
            ...(config.ksaImport ?? {}),
            applyAtStartup: false,
        };
        this.log.info('KSA import applied to config.json and applyAtStartup has been reset');
    }

    /** The user's rows, as written, plus the pairs the backup adds. */
    private persistDomusPairs(platformConfig: Record<string, unknown>, result: KsaImportResult): void {
        const current = typeof platformConfig.domusThermostat === 'object' && platformConfig.domusThermostat !== null
            ? platformConfig.domusThermostat as Record<string, unknown>
            : {};
        const derived = result.derivedConfig.domusThermostat;
        const manualPairs = planPairMerge(current.manualPairs, derived.manualPairs, 'domusSensorId');
        const manualCommandPairs = planPairMerge(current.manualCommandPairs, derived.manualCommandPairs, 'commandThermostatId');
        if (manualPairs.additions.length === 0 && manualCommandPairs.additions.length === 0) return;
        platformConfig.domusThermostat = {
            ...current,
            ...(manualPairs.additions.length > 0
                ? { manualPairs: [...existingRows(current.manualPairs), ...manualPairs.additions] }
                : {}),
            ...(manualCommandPairs.additions.length > 0
                ? { manualCommandPairs: [...existingRows(current.manualCommandPairs), ...manualCommandPairs.additions] }
                : {}),
        };
    }

    private logPreview(result: KsaImportResult): void {
        const summary = result.summary;
        this.log.info(
            `KSA parsed: outputs=${summary.outputs}, zones=${summary.zones}, scenarios=${summary.scenarios}, sensors=${summary.sensors}, thermostats=${summary.thermostats}, rooms=${summary.rooms}`,
        );
        for (const pair of result.derivedConfig.domusThermostat.manualCommandPairs) {
            const sensorPair = result.derivedConfig.domusThermostat.manualPairs.find(
                (entry) => entry.thermostatOutputId === pair.thermostatOutputId,
            );
            this.log.debug(
                `KSA mapping thermostat_${pair.thermostatOutputId} => cfg:${pair.commandThermostatId} domus:${sensorPair?.domusSensorId ?? 'NA'} source:ksa_cache`,
            );
        }
    }
}
