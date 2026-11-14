/**
 * Which Thermostat cluster payload the plugin registers for a device.
 *
 * - `conformant` (first attempt): only the attributes of the features the
 *   device really has. Homebridge 2.5 composes the Thermostat cluster from the
 *   attributes it receives (`homebridge/dist/matter/server/AccessoryManager.js:426-429`
 *   → `serverHelpers.js:370-390`): occupied heating/cooling setpoints turn on
 *   Heating/Cooling, both turn on AutoMode, any unoccupied setpoint turns on
 *   Occupancy, and nothing ever turns on Presets. matter.js 0.18 then refuses
 *   every attribute whose feature is missing (`@matter/node/dist/esm/behavior/
 *   state/validation/conformance-compiler.js:431-438`): `presetTypes` and
 *   `numberOfPresets` ("PRES", `@matter/model/dist/esm/standard/elements/
 *   thermostat-cluster.element.js:403-407, 426-430`), `minSetpointDeadBand`
 *   without AutoMode ("AUTO", same file :175-179). `thermostatRunningState` is
 *   optional without a feature (:249-254) and is accepted.
 * - `legacy` (second attempt): the 2.2.0 payload, every heating, cooling,
 *   occupancy and deadband attribute plus the preset workaround that matter.js
 *   0.17 alphas wanted. Only for a runtime that refused the conformant one.
 *
 * The choice is per device UUID and per process: every path that builds the
 * cluster (register, re-map, state update) reads it here, so a registration
 * switched to `legacy` keeps getting updates of the same shape. A restart
 * starts again from `conformant`.
 */

export type ThermostatShape = 'conformant' | 'legacy';

/**
 * Revision of the payload the first attempt sends (1 = the 2.2.0 payload, 2 =
 * the conformant one). A persisted fallback older than this revision was never
 * tried with it and gets one automatic attempt (`matter-fallback-store.ts`).
 */
export const THERMOSTAT_SHAPE_REVISION = 2;

const legacyShapeUUIDs = new Set<string>();

export function thermostatShapeOf(uuid: string): ThermostatShape {
    return legacyShapeUUIDs.has(uuid) ? 'legacy' : 'conformant';
}

export function setThermostatShape(uuid: string, shape: ThermostatShape): void {
    if (shape === 'legacy') legacyShapeUUIDs.add(uuid);
    else legacyShapeUUIDs.delete(uuid);
}

// PresetScenarioEnum (Matter spec §4.3.8.16)
export const PRESET_SCENARIO_OCCUPIED = 1;

/**
 * The 2.2.0 workaround: matter.js 0.17 alphas validated the Presets schema even
 * without the Presets feature, so `presetTypes` needed one entry, with
 * `presetTypeFeatures` as a bitmap object (BitmapManager rejects raw numbers).
 * Sent only by the `legacy` shape.
 */
export function getThermostatPresetWorkaroundAttributes(): Record<string, unknown> {
    return {
        numberOfPresets: 1,
        presetTypes: [
            {
                presetScenario: PRESET_SCENARIO_OCCUPIED,
                numberOfPresets: 1,
                presetTypeFeatures: { automatic: false, supportsNames: false },
            },
        ],
    };
}
