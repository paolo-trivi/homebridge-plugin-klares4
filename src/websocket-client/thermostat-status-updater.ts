import { stripDevicePrefix } from '../device-id';
import type { ThermostatMode } from '../thermostat-mode';
import { updateThermostatStatus } from '../thermostat-state';
import type {
    KseniaDevice,
    KseniaTemperatureStatusRaw,
    KseniaThermostat,
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
                this.deps.state.thermostatCommandIdByOutputId.set(outputThermostatId, entry.ID);
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

    private resolveThermostatOutputIds(statusId: string): string[] {
        const matches = new Set<string>();
        for (const device of this.deps.state.devices.values()) {
            if (device.type !== 'thermostat') {
                continue;
            }

            const outputThermostatId = stripDevicePrefix(device.id);
            const manualCommandId = this.getManualCommandId(outputThermostatId);
            const programCommandId = this.deps.state.thermostatProgramIdByOutputId.get(outputThermostatId);
            const candidates = [
                manualCommandId,
                programCommandId,
                this.deps.state.thermostatCommandIdByOutputId.get(outputThermostatId),
            ];
            if (this.deps.state.thermostatProgramById.size === 0) {
                candidates.push(this.deps.state.thermostatToDomus.get(outputThermostatId));
                candidates.push(outputThermostatId);
            }
            if (candidates.includes(statusId)) {
                matches.add(outputThermostatId);
            }
        }
        return [...matches];
    }

    private getManualCommandId(outputThermostatId: string): string | undefined {
        const pair = this.deps.state.domusThermostatConfig.manualCommandPairs.find(
            (item) => stripDevicePrefix(item.thermostatOutputId) === outputThermostatId,
        );
        return pair ? stripDevicePrefix(pair.commandThermostatId) : undefined;
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
