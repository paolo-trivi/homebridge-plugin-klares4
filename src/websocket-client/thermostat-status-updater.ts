import { stripDevicePrefix } from '../device-id';
import type { ThermostatMode } from '../thermostat-mode';
import { updateThermostatStatus } from '../thermostat-state';
import type {
    KseniaDevice,
    KseniaTemperatureStatusRaw,
} from '../types';
import { parseFloatInRange } from '../websocket/device-state-projector';
import type { WebSocketClientState } from './types';

interface ThermostatStatusUpdaterDeps {
    state: WebSocketClientState;
    emitDeviceStatusUpdate: (device: KseniaDevice) => void;
}

export class ThermostatStatusUpdater {
    constructor(private readonly deps: ThermostatStatusUpdaterDeps) {}

    public updateTemperatureStatuses(entries: KseniaTemperatureStatusRaw[]): void {
        for (const entry of entries) {
            this.recordRealtimeSnapshot(entry);
            const thermostatOutputIds = this.resolveThermostatOutputIds(entry.ID);
            if (thermostatOutputIds.length === 0) {
                this.deps.state.pendingTemperatureStatuses.set(entry.ID, entry);
                continue;
            }

            this.deps.state.pendingTemperatureStatuses.delete(entry.ID);
            const patch = buildThermostatPatch(entry);
            for (const outputThermostatId of thermostatOutputIds) {
                const thermostatDevice = this.deps.state.devices.get(`thermostat_${outputThermostatId}`);
                if (!thermostatDevice || thermostatDevice.type !== 'thermostat') {
                    continue;
                }

                const changed = updateThermostatStatus(thermostatDevice, patch);
                // NOTE: previously we wrote `thermostatCommandIdByOutputId[outputId] = entry.ID`
                // here, but `entry.ID` from STATUS_TEMPERATURES is the DOMUS sensor id,
                // NOT the cfg/program id that `thermostatCommandIdByOutputId` is supposed
                // to hold. That write poisoned the cache used by the command resolver
                // (command-service.ts) and the config-sync path, which then routed
                // WRITE_CFG to a stale/sensor id. Removed entirely: the only legitimate
                // writers of this map are `command-service.ts` and `thermostat-config-sync.ts`,
                // both of which already write the cfg id.
                this.deps.state.thermostatRealtimeByOutputId.set(outputThermostatId, Date.now());
                if (changed) {
                    this.deps.emitDeviceStatusUpdate(thermostatDevice);
                }
            }
        }
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
     * "swapped" sensor/program pairs (e.g. Matrimoniale: cfg=3 sensor=4, Bagno:
     * cfg=4 sensor=3). On those setups, a STATUS_TEMPERATURES targeted at one
     * thermostat would silently patch the *other*: change Matrimoniale setpoint to
     * 25 °C and Bagno's targetTemperature ended up at 25 °C too. Devices whose
     * (cfg, sensor) pair coincides numerically (e.g. Studio cfg=5 sensor=5) were
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

    private recordRealtimeSnapshot(entry: KseniaTemperatureStatusRaw): void {
        const previous = this.deps.state.thermostatRealtimeSnapshotById.get(entry.ID);
        const next = {
            mode: parseThermostatMode(entry),
            targetTemperature: parseFloatInRange(entry.THERM?.TEMP_THR?.VAL, 5, 40),
            hvacOutputActive: parseThermostatOutputActive(entry.THERM?.OUT_STATUS),
            updatedAt: Date.now(),
        };
        if (
            previous
            && previous.mode === next.mode
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
}> {
    return {
        currentTemperature: parseFloatInRange(entry.TEMP, -50, 100),
        targetTemperature: parseFloatInRange(entry.THERM?.TEMP_THR?.VAL, 5, 40),
        mode: parseThermostatMode(entry),
        hvacOutputActive: parseThermostatOutputActive(entry.THERM?.OUT_STATUS),
    };
}

function parseThermostatMode(entry: KseniaTemperatureStatusRaw): ThermostatMode | undefined {
    const actModel = entry.THERM?.ACT_MODEL?.toUpperCase();
    if (actModel === 'OFF') {
        return 'off';
    }
    if (actModel === 'AUTO') {
        return 'auto';
    }
    if (actModel === 'MAN') {
        return entry.THERM?.ACT_SEA?.toUpperCase() === 'SUM' ? 'cool' : 'heat';
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
