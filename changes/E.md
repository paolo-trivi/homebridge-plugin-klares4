# E — Matter thermostats

Findings: TH-01 / MAT-01, TH-05, TH-08 (closes F33), TH-09, TH-10 (Matter side), TH-14, TH-15, TH-17 and the thermostat part of MAT-15.

## Config keys

None added, renamed or removed. `matterRecoveryRequests` keeps working as before.

## Shared types (additive, optional)

| Type | Field | Meaning | Who fills it |
|---|---|---|---|
| `KseniaThermostat` (`src/types/device.types.ts`) | `outputRole?: 'heating' \| 'cooling' \| 'heating-cooling'` | role of the output in its thermostat program (`HEATING_OUT` / `COOLING_OUT`) | discovery layer (task D or integration), with `deriveThermostatOutputRole(outputId, program, panelName)` from `src/platform/matter-thermostat-role.ts` |
| `ThermostatStatus` (`src/types/device-status.types.ts`) | `season?: 'winter' \| 'summer'` | active season from the realtime `ACT_SEA` (`WIN` / `SUM`) | thermostat status updater (task D) |

Both are read if present. Without `outputRole` the Matter endpoint falls back to the 2.2.0 name heuristic (see "Integration" below); without `season` the season is inferred from `MAN` + season (`heat` = winter, `cool` = summer) and is unknown in `AUTO`/`OFF`.

## Changelog entries (2.3.0)

### Fixed
- Thermostats register as real Matter thermostats again on Homebridge 2.5. Since Homebridge 2.5 (matter.js 0.18) every thermostat fell back to a temperature sensor after about 30 seconds, and `matterRecoveryRequests` could not bring it back, because the plugin sent preset attributes the runtime refuses. The plugin now declares only the attributes of what the thermostat can do; if a Homebridge version does not accept that, it tries once more with the payload of 2.2.0 before falling back to a temperature sensor. (TH-01, MAT-01)
- Thermostats that an earlier version had saved as a temperature-sensor fallback get one automatic attempt to become thermostats again at the first start of 2.3.0, without `matterRecoveryRequests`. If Homebridge does not accept the thermostat, the temperature sensor comes back as before and no further automatic attempt is made. (TH-01)
- A heating output and a cooling output of the same Ksenia program no longer act on each other in Matter. The heating output shows Off while the program runs in summer (and the cooling output while it runs in winter), refuses a setpoint or Heat in that season instead of writing the summer setpoint or switching the whole program to winter, and does not forward Off (which would stop the cooling). The role comes from the program data, not from the device name: renaming a thermostat in `matterOverrides` or `customNames` no longer changes what it can do. (TH-05)
- A Matter command sent shortly after another one is no longer dropped as "already current" because the panel had not reported the first one yet (for example 26 °C and then back to 23 °C, or Off and then Heat, within two seconds). Two quick +1 °C steps now add up to +2 °C. (TH-08, F33)
- Matter thermostats no longer declare the Occupancy feature: the "unoccupied" setpoints, which the plugin never used, are gone. (TH-09)
- Matter thermostats publish whether the heating or cooling output is running (`thermostatRunningState`). (TH-10)
- Auto (and Cool) on a heating-only Matter thermostat is refused to the controller instead of being accepted and silently ignored. A cooling-only output refuses Heat and Auto the same way. (TH-15)
- A Matter thermostat command that cannot reach the panel (no connection) is reported as failed and the previous value comes back, instead of looking accepted. (TH-17, MAT-15)
- The Matter fallback store no longer rewrites a file it does not understand (a version written as text, an unknown layout): it is left untouched and the state is kept in memory. An unreadable file is copied to `klares4-matter-fallback.json.unreadable.bak` before the store starts again. A recovery in progress is no longer reported as "interrupted" by the plugin itself while it is still running. (TH-14)

### Changed
- Heating-only thermostats (and cooling-only ones, when the program data says so) are exposed to Matter with only that capability: no cooling slider, no Auto. Thermostats whose output does both keep heating, cooling and Auto. (TH-01, TH-05)

## Migration notes
- **Homebridge 2.5 users** (every thermostat was a temperature sensor): at the first start of 2.3.0 each thermostat in `klares4-matter-fallback.json` is removed as a temperature sensor and registered as a thermostat, once. In Apple Home / Alexa / Google the temperature sensor disappears and a thermostat appears (new accessory: rooms and automations that used the sensor must be set again). Watch the log for `was saved as a TemperatureSensor fallback by an earlier version; trying the native Thermostat once`. If it falls back again, the log says why; `matterRecoveryRequests` still allows another explicit attempt.
- **Users whose thermostats were native** (Homebridge versions that accepted the 2.2.0 payload): the cluster now has fewer features (no Occupancy, no Auto/Cooling on heating-only outputs). Homebridge sees a different endpoint shape in its cache and replaces the endpoint at the first start; controllers may show it as changed.
- The store file gains an optional field `nativeShapeRevision` (the Thermostat payload revision of the last native attempt). 2.2.0 reads the file unchanged (the field is kept as is).
- Without the program data (no `PRG_THERMOSTATS` and no `.ksa`), the plugin still decides heating-only vs heating-and-cooling from the name, as 2.2.0 did, until the discovery layer fills `outputRole` (see below).

## Integration (requests to other tasks)

### F1 — second registration attempt (`src/platform/matter-registration-recovery.ts`)
The first attempt (conformant payload) needs no hook. The second attempt, for a runtime that refuses it, needs this in the recovery path, **before** the TemperatureSensor fallback, in both `handleMissingRegisteredAccessory` (probe negative) and `handleRegisterFailure` (register threw, not transient):

```ts
import { nextThermostatAttempt, resetThermostatAttempts } from './matter-thermostat-attempts';

// handleMissingRegisteredAccessory, before `if (shouldFallbackThermostat)`:
// handleRegisterFailure, before the fallback branch, when !transient:
const next = reg.deviceType === 'thermostat' && !isFallbackTemperatureSensor(reg)
    ? nextThermostatAttempt(reg.matterAccessory) : undefined;
if (next) {
    deps.log.warn(`[Matter] ${reg.displayName}: Homebridge did not create the Thermostat; trying the 2.2.0 payload before falling back`);
    await removeBeforeReregister(reg, deps);
    // the registry's echo tracker should also record next.clusters.thermostat as pushed (as performRegistration does)
    await deps.topologyCoordinator.register(next);
    reg.matterAccessory = next;
    reg.registeredDisplayName = next.displayName;
    reg.status = 'pending';
    deps.scheduleComplete(reg.uuid);
    return;
}
// and in registerFallbackAccessory: resetThermostatAttempts(device.id);
```
`nextThermostatAttempt(accessory: MatterAccessory): MatterAccessory | undefined` returns the same accessory (UUID, metadata, handlers) with the Thermostat cluster rebuilt with the 2.2.0 payload, and from then on every cluster built for that UUID (re-map, state updates) has the same attribute set; it returns `undefined` when there is no further attempt. Tested by hand-driving the chain on the fixture (`test/matter-thermostat-role-attempts.test.js`, "the attempt chain ends native").

The automatic recovery of old fallbacks needs no hook: it lives in `resolvePersistedThermostatFallback` (`matter-thermostat-recovery-request.ts`, same signature) and the store.

### D (or integration) — fill `outputRole` and `status.season`
- `outputRole`: where thermostat devices are created or refreshed after `PRG_THERMOSTATS` / the `.ksa` cache (`thermostat-read-handler.ts` `cacheProgramThermostats`, and the `.ksa` path that fills `thermostatProgramById` in `websocket-client/state.ts`):
  `device.outputRole = deriveThermostatOutputRole(outputId, state.thermostatProgramById.get(state.thermostatProgramIdByOutputId.get(outputId) ?? ''), panelName)` on the client's own device (panel name, before `customNames`). The Matter copy carries it.
- `status.season`: in `thermostat-status-updater.ts` from `THERM.ACT_SEA` (`parseSeason` already exists): `WIN` → `'winter'`, `SUM` → `'summer'`, and `updateThermostatStatus` should accept it in its partial. Needed for the right Off/Heat on a heating output in `AUTO`, and for the running state of an output that does both.

### F2 — none required
`matter-device-mapper.ts` keeps calling `buildThermostatMatterState(device)`, `thermostatSupportsCooling(device)` and `buildThermostatHandlers({...})` with unchanged signatures. `supportsCooling` in the handler deps is now ignored (the handlers read the role from the latest snapshot); it can be dropped later. `domainModeToMatterMode` there duplicates `domainModeToMatterSystemMode`.

## Documentation notes (task L)
- `docs/MATTER_TROUBLESHOOTING.md` (EN/IT): the "fixed via the bitmap workaround" text about thermostat fallbacks is wrong since Homebridge 2.5. Replace with: the plugin registers the Thermostat with only the attributes of the output's role (Homebridge 2.5 derives the features from them), tries the 2.2.0 payload once if that is refused, then falls back; old fallbacks get one automatic attempt; `matterRecoveryRequests` for any further attempt. Mention the log lines quoted above and the `.unreadable.bak` copy.
- Thermostat page (EN/IT): one Ksenia program with a heating and a cooling output appears in Matter as two thermostats, heating-only and cooling-only; each shows Off out of its season and refuses commands there. On HAP nothing changes in this release.
- ARCHITECTURE: `matter-thermostat-role.ts` (role and season, pure), `matter-thermostat-shape.ts` (payload choice per UUID), `matter-thermostat-attempts.ts` (attempt chain), the ACK-confirmed values in `MatterThermostatEchoTracker`.

## To verify in the field (rc)
- A thermostat on the production bridge registers as Thermostat after the automatic recovery, and Apple Home / Alexa show heating only for heating outputs.
- Apple Home and Alexa behaviour on a heating output while the program is in summer (endpoint Off; a refused Heat comes back to Off).
- On a Homebridge 2.4.x bridge (CI matrix): whether the conformant payload is accepted, or the second attempt is needed (only with the F1 hook).
