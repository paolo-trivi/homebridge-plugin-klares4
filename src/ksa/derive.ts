import { createHash } from 'crypto';
import type { KsaSanitizedCache } from '../types';
import { determineOutputType } from '../websocket/device-state-projector';
import type { KsaDerivedConfig, KsaImportResult, KsaMapRecord, ParsedKsaProgram } from './types';

export function deriveKsaImportResult(
    program: ParsedKsaProgram,
    sourceFilePath: string | undefined,
    rawBytes: Buffer,
): KsaImportResult {
    const cache = buildSanitizedCache(program, sourceFilePath, rawBytes);
    const derivedConfig = buildDerivedConfig(program, cache);
    return {
        summary: {
            outputs: program.outputs.length,
            zones: program.zones.length,
            scenarios: program.scenarios.length,
            sensors: program.busHas.length,
            thermostats: program.thermostats.length,
            rooms: program.rooms.length,
            maps: program.maps.length,
        },
        cache,
        derivedConfig,
    };
}

function buildSanitizedCache(program: ParsedKsaProgram, sourceFilePath: string | undefined, rawBytes: Buffer): KsaSanitizedCache {
    const thermostatProgramIdByOutputId: Record<string, string> = {};
    const domusSensorIdByThermostatProgramId: Record<string, string> = {};
    const thermostatPrograms = program.thermostats
        .map((thermostat) => {
            const thermostatProgramId = asId(thermostat.ID);
            if (!thermostatProgramId) {
                return null;
            }
            const heatingOutputId = normalizeNullableId(thermostat.HEATING_OUT);
            const coolingOutputId = normalizeNullableId(thermostat.COOLING_OUT);
            const domusSensorId = normalizeNullableId(thermostat.PERIPH?.PID);
            if (heatingOutputId) {
                thermostatProgramIdByOutputId[heatingOutputId] = thermostatProgramId;
            }
            if (coolingOutputId) {
                thermostatProgramIdByOutputId[coolingOutputId] = thermostatProgramId;
            }
            if (domusSensorId) {
                domusSensorIdByThermostatProgramId[thermostatProgramId] = domusSensorId;
            }
            return {
                id: thermostatProgramId,
                description: normalizeLabel(thermostat.DES) ?? undefined,
                heatingOutputId: heatingOutputId ?? undefined,
                coolingOutputId: coolingOutputId ?? undefined,
                domusSensorId: domusSensorId ?? undefined,
            };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    return {
        sourceFilePath,
        sourceFileHash: createHash('sha256').update(rawBytes).digest('hex'),
        parsedAt: new Date().toISOString(),
        thermostatPrograms,
        thermostatProgramIdByOutputId,
        domusSensorIdByThermostatProgramId,
        outputNamesById: toNameRecord(program.outputs),
        zoneNamesById: toNameRecord(program.zones),
        scenarioNamesById: toNameRecord(program.scenarios),
        domusSensorNamesById: toNameRecord(program.busHas.map((sensor) => ({
            ID: sensor.ID,
            DES: sensor.DOMUS?.DES ?? `Sensor ${sensor.ID}`,
        }))),
        roomNameById: toNameRecord(program.rooms),
        roomDeviceRefs: toRoomDeviceRefs(program.maps),
    };
}

function buildDerivedConfig(program: ParsedKsaProgram, cache: KsaSanitizedCache): KsaDerivedConfig {
    const outputById = new Map(program.outputs.map((output) => [String(output.ID), output]));
    const roomNameById = cache.roomNameById;
    const roomDevices = new Map<string, Set<string>>();

    for (const map of cache.roomDeviceRefs) {
        const roomName = roomNameById[map.roomId];
        if (!roomName) {
            continue;
        }
        const resolvedDeviceIds = resolveRoomMapToDeviceIds(map, outputById);
        if (resolvedDeviceIds.length === 0) {
            continue;
        }
        const bucket = roomDevices.get(roomName) ?? new Set<string>();
        for (const deviceId of resolvedDeviceIds) {
            bucket.add(deviceId);
        }
        roomDevices.set(roomName, bucket);
    }

    return {
        domusThermostat: {
            manualPairs: Object.entries(cache.thermostatProgramIdByOutputId)
                .map(([outputId, thermostatProgramId]) => ({
                    thermostatOutputId: outputId,
                    domusSensorId: cache.domusSensorIdByThermostatProgramId[thermostatProgramId],
                }))
                .filter((pair) => Boolean(pair.domusSensorId)),
            manualCommandPairs: Object.entries(cache.thermostatProgramIdByOutputId)
                .map(([outputId, thermostatProgramId]) => ({
                    thermostatOutputId: outputId,
                    commandThermostatId: thermostatProgramId,
                })),
        },
        roomMapping: {
            enabled: true,
            rooms: [...roomDevices.entries()].map(([roomName, devices]) => ({
                roomName,
                devices: [...devices].map((deviceId) => ({ deviceId })),
            })),
        },
        customNames: {
            outputs: cache.outputNamesById,
            zones: cache.zoneNamesById,
            sensors: cache.domusSensorNamesById,
            scenarios: cache.scenarioNamesById,
        },
        suggestedExclusions: {
            outputs: [],
            zones: [],
            sensors: [],
            scenarios: [],
        },
    };
}

function resolveRoomMapToDeviceIds(map: { objectType: string; objectId: string }, outputById: Map<string, { CAT?: string; MOD?: string }>): string[] {
    if (map.objectType === 'prgOutputs') {
        const output = outputById.get(map.objectId);
        if (!output) {
            return [];
        }
        const outputType = determineOutputType(output.CAT ?? '', output.MOD);
        return [`${outputType}_${map.objectId}`];
    }
    if (map.objectType === 'prgZones') {
        return [`zone_${map.objectId}`];
    }
    if (map.objectType === 'prgScenarios') {
        return [`scenario_${map.objectId}`];
    }
    if (map.objectType === 'prgBusHas') {
        return [`sensor_temp_${map.objectId}`, `sensor_hum_${map.objectId}`, `sensor_light_${map.objectId}`];
    }
    return [];
}

function toNameRecord(items: Array<{ ID: string; DES?: string }>): Record<string, string> {
    const record: Record<string, string> = {};
    for (const item of items) {
        const id = asId(item.ID);
        if (!id) {
            continue;
        }
        const name = normalizeLabel(item.DES);
        if (name) {
            record[id] = name;
        }
    }
    return record;
}

function toRoomDeviceRefs(maps: KsaMapRecord[]): Array<{ roomId: string; objectType: string; objectId: string }> {
    return maps
        .map((map) => ({
            roomId: asId(map.ROOM),
            objectType: normalizeLabel(map.OT) ?? '',
            objectId: asId(map.OID),
        }))
        .filter((map) => Boolean(map.roomId) && Boolean(map.objectType) && Boolean(map.objectId)) as Array<{
            roomId: string;
            objectType: string;
            objectId: string;
        }>;
}

function asId(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value).toString();
    }
    return '';
}

function normalizeNullableId(value: unknown): string | null {
    const normalized = asId(value);
    if (!normalized || normalized.toUpperCase() === 'NU' || normalized.toUpperCase() === 'NA') {
        return null;
    }
    return normalized;
}

function normalizeLabel(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized ? normalized : null;
}
