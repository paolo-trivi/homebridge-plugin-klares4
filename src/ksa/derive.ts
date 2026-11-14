import { createHash } from 'crypto';
import type { KsaSanitizedCache } from '../types';
import { createDeviceSlug } from '../mqtt/topic-parser';
import { determineOutputType } from '../websocket/device-state-projector';
import type { KsaDerivedConfig, KsaImportResult, KsaMapRecord, ParsedKsaProgram } from './types';

export function deriveKsaImportResult(
    program: ParsedKsaProgram,
    sourceFilePath: string | undefined,
    rawBytes: Buffer,
): KsaImportResult {
    program = onlyRecordEntries(program);
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
        const panelRoomName = ownValue(roomNameById, map.roomId);
        if (!panelRoomName) {
            continue;
        }
        // Room names end up in MQTT topics: '/', '+', '#' and spaces must never reach them.
        const roomName = createDeviceSlug(panelRoomName) || `room_${createDeviceSlug(map.roomId) || 'unnamed'}`;
        if (!ROOM_NAME_PATTERN.test(roomName)) {
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
                    domusSensorId: ownValue(cache.domusSensorIdByThermostatProgramId, thermostatProgramId),
                }))
                .filter((pair): pair is { thermostatOutputId: string; domusSensorId: string } => Boolean(pair.domusSensorId)),
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

function isRecord(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `.ksa` file is untrusted input: one null or scalar entry must not abort the whole import. */
function onlyRecordEntries(program: ParsedKsaProgram): ParsedKsaProgram {
    const keep = <T>(entries: T[] | undefined): T[] => (Array.isArray(entries) ? entries.filter(isRecord) : []);
    return {
        outputs: keep(program.outputs),
        zones: keep(program.zones),
        scenarios: keep(program.scenarios),
        busHas: keep(program.busHas),
        thermostats: keep(program.thermostats),
        rooms: keep(program.rooms),
        maps: keep(program.maps),
    };
}

/** Own-property lookup: an ID such as "constructor" must not resolve to an inherited member. */
function ownValue(record: Record<string, string>, key: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * The `.ksa` is untrusted input and its IDs end up in `config.json` and in
 * device IDs: only what `config.schema.json` accepts for an ID (digits) gets through.
 */
const PANEL_ID_PATTERN = /^[0-9]{1,9}$/;
const ROOM_NAME_PATTERN = /^[a-z0-9_]+$/;
/** The longest name HomeKit accepts. */
const MAX_NAME_LENGTH = 64;

function asId(value: unknown): string {
    let text = '';
    if (typeof value === 'string') {
        text = value.trim();
    } else if (typeof value === 'number' && Number.isFinite(value)) {
        text = Math.trunc(value).toString();
    }
    return PANEL_ID_PATTERN.test(text) ? text : '';
}

/** Unused links are written `NU` or `NA` by the panel: not digits, so they come out as null. */
function normalizeNullableId(value: unknown): string | null {
    return asId(value) || null;
}

function normalizeLabel(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = Array.from(value.trim()).slice(0, MAX_NAME_LENGTH).join('').trim();
    return normalized ? normalized : null;
}
