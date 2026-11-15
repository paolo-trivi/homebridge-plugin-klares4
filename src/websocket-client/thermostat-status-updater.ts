import type { Logger } from 'homebridge';
import { stripDevicePrefix } from '../device-id';
import type { ThermostatMode } from '../thermostat-mode';
import { updateThermostatStatus } from '../thermostat-state';
import type {
    KseniaDevice,
    KseniaTemperatureStatusRaw,
} from '../types';
import { parseFloatInRange } from '../websocket/device-state-projector';
import { forEachIsolated } from '../isolation';
import { nextThermostatEventSeq } from './thermostat-sequence';
import type { WebSocketClientState } from './types';

interface ThermostatStatusUpdaterDeps {
    state: WebSocketClientState;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
    /** When set, a failing entry is logged and skipped instead of aborting the batch. */
    log?: Logger;
}

export class ThermostatStatusUpdater {
    private readonly reportedUnknownModels = new Set<string>();

    constructor(private readonly deps: ThermostatStatusUpdaterDeps) {}

    public updateTemperatureStatuses(entries: KseniaTemperatureStatusRaw[]): void {
        forEachIsolated(this.deps.log, 'STATUS_TEMPERATURES entry', entries, (entry: KseniaTemperatureStatusRaw): void => {
            const seq = nextThermostatEventSeq(this.deps.state);
            this.recordRealtimeSnapshot(entry);
            const thermostatOutputIds = this.resolveThermostatOutputIds(entry.ID);
            if (thermostatOutputIds.length === 0) {
                this.deps.state.pendingTemperatureStatuses.set(entry.ID, entry);
                return;
            }

            this.deps.state.pendingTemperatureStatuses.delete(entry.ID);
            this.reportUnknownModel(entry);
            const patch = buildThermostatPatch(entry);
            for (const outputThermostatId of thermostatOutputIds) {
                this.recordRealtimeSeason(outputThermostatId, entry, seq);
                const thermostatDevice = this.deps.state.devices.get(`thermostat_${outputThermostatId}`);
                if (!thermostatDevice || thermostatDevice.type !== 'thermostat') {
                    continue;
                }

                const changed = updateThermostatStatus(thermostatDevice, patch);
                // Never `thermostatCommandIdByOutputId[outputId] = entry.ID`: entry.ID is
                // the DOMUS sensor id, not a cfg id; only the command resolver and the
                // cfg sync write that map.
                const now = Date.now();
                this.deps.state.thermostatRealtimeByOutputId.set(outputThermostatId, now);
                thermostatDevice.status.observedAt = now;
                thermostatDevice.status.observedSeq = seq;
                if (changed) {
                    this.deps.emitDeviceStatusUpdate(thermostatDevice);
                }
            }
        });
    }

    public applyPendingTemperatureStatuses(): void {
        const pendingEntries = [...this.deps.state.pendingTemperatureStatuses.values()];
        if (pendingEntries.length === 0) {
            return;
        }
        this.updateTemperatureStatuses(pendingEntries);
    }

    /**
     * Resolve which Lares4 output-thermostat(s) a `STATUS_TEMPERATURES.ID` refers to.
     *
     * IMPORTANT (verified via debug capture 2026-05-23T07-29-03):
     *   `STATUS_TEMPERATURES.ID` is the **DOMUS sensor id**, NOT the program/cfg id.
     *   The Lares4 panel broadcasts thermostat state indexed by the DOMUS probe that
     *   measures the room temperature, not by the cronotermostato program number.
     *
     * The previous implementation compared `statusId` against the thermostat's
     * `manualCommandId` / `programCommandId` / `cachedCommandId` — all of which are
     * cfg ids — producing a numeric collision in setups where two thermostats have
     * "swapped" sensor/program pairs (e.g. room A: cfg=3 sensor=4, room B:
     * cfg=4 sensor=3). On those setups, a STATUS_TEMPERATURES targeted at one
     * thermostat would silently patch the *other*: change room A's setpoint to
     * 25 °C and room B's targetTemperature ended up at 25 °C too. Devices whose
     * (cfg, sensor) pair coincides numerically (e.g. room C: cfg=5 sensor=5) were
     * spared by accident, masking the bug.
     *
     * The fix: for each thermostat compute its **expected DOMUS sensor id** and
     * match `statusId` against that. Sources, in priority order:
     *   1. `state.thermostatToDomus` — runtime DOMUS thermostat mapping (manual /
     *      auto / program), the canonical source whenever it's populated.
     *   2. `state.domusSensorIdByThermostatProgramId[programCommandId]` —
     *      derived from PRG_THERMOSTATS at runtime or from the KSA cache; needed
     *      when `thermostatToDomus` hasn't been built yet (first STATUS_TEMPERATURES
     *      can arrive before the DOMUS mapping refresh).
     *
     * Degraded path (no PRG_THERMOSTATS and no DOMUS mapping at all): match
     * exactly on `outputThermostatId` and fall through. We do NOT include the cfg
     * ids in candidates — that was the root cause of the cross-pollination bug.
     */
    private resolveThermostatOutputIds(statusId: string): string[] {
        const matches = new Set<string>();
        for (const device of this.deps.state.devices.values()) {
            if (device.type !== 'thermostat') {
                continue;
            }

            const outputThermostatId = stripDevicePrefix(device.id);
            const expectedSensorId = this.resolveExpectedSensorId(outputThermostatId);

            if (expectedSensorId !== undefined) {
                if (expectedSensorId === statusId) {
                    matches.add(outputThermostatId);
                }
                continue;
            }

            // Fully degraded: no DOMUS mapping at all. Last-resort match by
            // outputThermostatId (some firmwares broadcast that way for
            // standalone thermostats without a DOMUS probe).
            if (statusId === outputThermostatId) {
                matches.add(outputThermostatId);
            }
        }
        return [...matches];
    }

    /**
     * Returns the DOMUS sensor id we expect `STATUS_TEMPERATURES.ID` to carry for
     * a given output thermostat, or `undefined` if no DOMUS association is known
     * (caller falls back to the degraded path).
     */
    private resolveExpectedSensorId(outputThermostatId: string): string | undefined {
        const direct = this.deps.state.thermostatToDomus.get(outputThermostatId);
        if (direct !== undefined) return direct;

        const programId = this.deps.state.thermostatProgramIdByOutputId.get(outputThermostatId);
        if (programId !== undefined) {
            const sensorId = this.deps.state.domusSensorIdByThermostatProgramId.get(programId);
            if (sensorId !== undefined) return sensorId;
        }

        return undefined;
    }

    private recordRealtimeSeason(outputThermostatId: string, entry: KseniaTemperatureStatusRaw, seq: number): void {
        const season = parseSeason(entry);
        if (!season) return;
        // Stamped at every observation, not only on change: a season seen again
        // after one of our writes is newer than that write's ACK.
        this.deps.state.thermostatRealtimeSeasonByOutputId.set(outputThermostatId, { season, updatedAt: Date.now(), seq });
    }

    /** One warning per ACT_MODEL value the plugin does not know (see parseThermostatMode). */
    private reportUnknownModel(entry: KseniaTemperatureStatusRaw): void {
        const model = entry.THERM?.ACT_MODEL;
        if (typeof model !== 'string' || model.trim() === '' || KNOWN_MODELS.has(model.trim().toUpperCase())) return;
        const key = model.trim().toUpperCase();
        if (this.reportedUnknownModels.has(key)) return;
        this.reportedUnknownModels.add(key);
        const mapped = parseThermostatMode(entry);
        this.deps.log?.warn(
            `Thermostat realtime mode ACT_MODEL=${JSON.stringify(key.slice(0, 16))} is not known to the plugin: `
            + (mapped ? `shown as ${mapped} (it has an active setpoint)` : 'mode left unchanged')
            + '. Please report it with a debug capture.',
        );
    }

    private recordRealtimeSnapshot(entry: KseniaTemperatureStatusRaw): void {
        const previous = this.deps.state.thermostatRealtimeSnapshotById.get(entry.ID);
        const next = {
            mode: parseThermostatMode(entry),
            season: parseSeason(entry),
            targetTemperature: parseFloatInRange(entry.THERM?.TEMP_THR?.VAL, 5, 40),
            hvacOutputActive: parseThermostatOutputActive(entry.THERM?.OUT_STATUS),
            updatedAt: Date.now(),
        };
        if (
            previous
            && previous.mode === next.mode
            && previous.season === next.season
            && previous.targetTemperature === next.targetTemperature
            && previous.hvacOutputActive === next.hvacOutputActive
        ) {
            return;
        }
        this.deps.state.thermostatRealtimeSnapshotById.set(entry.ID, next);
    }
}

export function hasFreshThermostatRealtimeState(
    state: WebSocketClientState,
    outputThermostatId: string,
): boolean {
    const lastUpdate = state.thermostatRealtimeByOutputId.get(outputThermostatId);
    if (lastUpdate === undefined) {
        return false;
    }
    return Date.now() - lastUpdate <= state.domusThermostatConfig.sensorFreshnessMs;
}

function buildThermostatPatch(entry: KseniaTemperatureStatusRaw): Partial<{
    currentTemperature: number;
    targetTemperature: number;
    mode: ThermostatMode;
    hvacOutputActive: boolean;
    season: 'WIN' | 'SUM';
}> {
    return {
        currentTemperature: parseFloatInRange(entry.TEMP, -50, 100),
        targetTemperature: parseFloatInRange(entry.THERM?.TEMP_THR?.VAL, 5, 40),
        mode: parseThermostatMode(entry),
        hvacOutputActive: parseThermostatOutputActive(entry.THERM?.OUT_STATUS),
        season: parseSeason(entry),
    };
}

const KNOWN_MODELS = new Set(['OFF', 'AUTO', 'MAN']);

function parseSeason(entry: KseniaTemperatureStatusRaw): 'WIN' | 'SUM' | undefined {
    const actSea = entry.THERM?.ACT_SEA?.toUpperCase();
    return actSea === 'SUM' ? 'SUM' : actSea === 'WIN' ? 'WIN' : undefined;
}

function parseThermostatMode(entry: KseniaTemperatureStatusRaw): ThermostatMode | undefined {
    const actModel = entry.THERM?.ACT_MODEL?.toUpperCase();
    if (actModel === 'OFF') {
        return 'off';
    }
    if (actModel === 'AUTO') {
        return 'auto';
    }
    const season = entry.THERM?.ACT_SEA?.toUpperCase() === 'SUM' ? 'cool' : 'heat';
    if (actModel === 'MAN') {
        return season;
    }
    // Unknown model (a timed manual, a special day...): with a live setpoint the
    // thermostat is regulating, so it is shown as heating/cooling rather than off.
    if (actModel && parseFloatInRange(entry.THERM?.TEMP_THR?.VAL, 5, 40) !== undefined) {
        return season;
    }
    return undefined;
}

function parseThermostatOutputActive(rawStatus?: string): boolean | undefined {
    if (!rawStatus) {
        return undefined;
    }

    const normalized = rawStatus.trim().toUpperCase();
    if (['OFF', '0', 'F', 'FALSE', 'CLOSE', 'CLOSED', 'IDLE', 'NA'].includes(normalized)) {
        return false;
    }
    if (['ON', '1', 'T', 'TRUE', 'OPEN', 'ACTIVE', 'HEAT', 'COOL'].includes(normalized)) {
        return true;
    }
    return undefined;
}
