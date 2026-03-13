import * as fs from 'fs';
import type { Logger } from 'homebridge';
import { KsaCacheService } from '../ksa/cache-service';
import { deriveKsaImportResult } from '../ksa/derive';
import { parseKsaProgramFromBuffer } from '../ksa/parser';
import type { KsaImportResult } from '../ksa/types';
import type { KsaSanitizedCache } from '../types';
import type { PlatformConfigFileService } from './config-file-service';
import type { Lares4Config } from './types';

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
            this.log.error(`KSA import failed (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
            return this.cacheService.load();
        }
    }

    private applyRuntimeConfig(config: Lares4Config, result: KsaImportResult): void {
        const importConfig = config.ksaImport ?? {};
        if (importConfig.applyDomusMappings !== false) {
            config.domusThermostat = {
                ...(config.domusThermostat ?? {}),
                manualPairs: result.derivedConfig.domusThermostat.manualPairs,
                manualCommandPairs: result.derivedConfig.domusThermostat.manualCommandPairs,
            };
        }

        if (importConfig.applyRoomMapping !== false) {
            config.roomMapping = result.derivedConfig.roomMapping;
        }

        if (importConfig.applyCustomNames) {
            config.customNames = {
                ...(config.customNames ?? {}),
                outputs: result.derivedConfig.customNames.outputs,
                zones: result.derivedConfig.customNames.zones,
                sensors: result.derivedConfig.customNames.sensors,
                scenarios: result.derivedConfig.customNames.scenarios,
            };
        }
    }

    private async persistAppliedConfig(platformName: string, result: KsaImportResult, config: Lares4Config): Promise<void> {
        await this.configFileService.updatePlatformConfig(platformName, (platformConfig) => {
            const importConfig = (platformConfig.ksaImport as Record<string, unknown> | undefined) ?? {};
            const applyDomusMappings = importConfig.applyDomusMappings !== false;
            const applyRoomMapping = importConfig.applyRoomMapping !== false;
            const applyCustomNames = importConfig.applyCustomNames === true;
            const applyExclusionSuggestions = importConfig.applyExclusionSuggestions === true;

            if (applyDomusMappings) {
                platformConfig.domusThermostat = {
                    ...(platformConfig.domusThermostat as Record<string, unknown> ?? {}),
                    manualPairs: result.derivedConfig.domusThermostat.manualPairs,
                    manualCommandPairs: result.derivedConfig.domusThermostat.manualCommandPairs,
                };
            }
            if (applyRoomMapping) {
                platformConfig.roomMapping = result.derivedConfig.roomMapping;
            }
            if (applyCustomNames) {
                platformConfig.customNames = {
                    outputs: result.derivedConfig.customNames.outputs,
                    zones: result.derivedConfig.customNames.zones,
                    sensors: result.derivedConfig.customNames.sensors,
                    scenarios: result.derivedConfig.customNames.scenarios,
                };
            }
            if (applyExclusionSuggestions) {
                platformConfig.excludeOutputs = result.derivedConfig.suggestedExclusions.outputs;
                platformConfig.excludeZones = result.derivedConfig.suggestedExclusions.zones;
                platformConfig.excludeSensors = result.derivedConfig.suggestedExclusions.sensors;
                platformConfig.excludeScenarios = result.derivedConfig.suggestedExclusions.scenarios;
            }

            platformConfig.ksaImport = {
                ...importConfig,
                applyAtStartup: false,
            };
            return true;
        });
        config.ksaImport = {
            ...(config.ksaImport ?? {}),
            applyAtStartup: false,
        };
        this.log.info('KSA import applied to config.json and applyAtStartup has been reset');
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
