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
 * The choice is per device UUID: every path that builds the cluster
 * (register, re-map, state update) reads it here, so a registration switched
 * to `legacy` keeps getting updates of the same shape. Each registry starts a
 * device from the shape that last worked for it, as the fallback store
 * remembers it (`startThermostatShapes`), and moves to the next untried shape
 * only when the runtime refuses the current one (`advanceThermostatShape`).
 */

export type ThermostatShape = 'conformant' | 'legacy';

/** Preferred order when nothing is remembered. */
const SHAPE_ORDER = ['conformant', 'legacy'] as const satisfies readonly ThermostatShape[];

/**
 * Revision of the payload the first attempt sends (1 = the 2.2.0 payload, 2 =
 * the conformant one). A persisted fallback older than this revision was never
 * tried with it and gets one automatic attempt; a remembered shape of another
 * revision is not trusted (`matter-fallback-store.ts`).
 */
export const THERMOSTAT_SHAPE_REVISION = 2;

const currentShapes = new Map<string, ThermostatShape>();
const triedShapes = new Map<string, Set<ThermostatShape>>();

export function thermostatShapeOf(uuid: string): ThermostatShape {
    return currentShapes.get(uuid) ?? SHAPE_ORDER[0];
}

/** A new series of attempts for `uuid`, starting from `first`. */
export function startThermostatShapes(uuid: string, first: ThermostatShape = SHAPE_ORDER[0]): void {
    currentShapes.set(uuid, first);
    triedShapes.set(uuid, new Set([first]));
}

/** Moves `uuid` to the next shape not tried in this series; `undefined` when all were tried. */
export function advanceThermostatShape(uuid: string): ThermostatShape | undefined {
    const tried = triedShapes.get(uuid) ?? new Set([thermostatShapeOf(uuid)]);
    const next = SHAPE_ORDER.find((shape) => !tried.has(shape));
    if (!next) return undefined;
    tried.add(next);
    triedShapes.set(uuid, tried);
    currentShapes.set(uuid, next);
    return next;
}

/** Forgets `uuid`: the next build uses the preferred shape. */
export function resetThermostatShapes(uuid: string): void {
    currentShapes.delete(uuid);
    triedShapes.delete(uuid);
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
