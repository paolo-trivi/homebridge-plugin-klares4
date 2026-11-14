# E — Matter thermostats

Findings: TH-01 / MAT-01, TH-05, TH-08 (closes F33), TH-09, TH-10 (Matter side), TH-14, TH-15, TH-17 and the thermostat part of MAT-15.

## Config keys

None added, renamed or removed. `matterRecoveryRequests` keeps working as before.

## Shared types (additive, optional)

| Type | Field | Meaning | Who fills it |
|---|---|---|---|
| `ThermostatStatus` (`src/types/device-status.types.ts`) | `outputRole?: ThermostatOutputRole` (`'heating' \| 'cooling' \| 'heating-cooling'`, type exported from the same file) | role of the output in its thermostat program (`HEATING_OUT` / `COOLING_OUT`) | discovery layer (task D), e.g. with `deriveThermostatOutputRole(outputId, program, panelName)` from `src/platform/matter-thermostat-role.ts` |
| `ThermostatStatus` | `season?: 'WIN' \| 'SUM'` | active season (`ACT_SEA`) | thermostat status updater (task D) |

The Matter code reads both only through these optional status fields. Task D adds the same two fields to `ThermostatStatus` (plus `observedAt`, `acknowledged`): when D is merged the two hunks meet in that interface; keep one declaration of each. D's `outputRole` is `'heating' | 'cooling'`; `'heating-cooling'` (the same output named as both `HEATING_OUT` and `COOLING_OUT`) is accepted by the Matter code and should be kept in the union. Without `outputRole` the Matter endpoint falls back to the 2.2.0 name heuristic; without `season` the season is inferred from `MAN` (`heat` = winter, `cool` = summer) and is unknown in `AUTO`/`OFF`.

## Changelog entries (2.3.0)

### Fixed
- Thermostats register as real Matter thermostats again on Homebridge 2.5. Since Homebridge 2.5 (matter.js 0.18) every thermostat fell back to a temperature sensor after about 30 seconds, and `matterRecoveryRequests` could not bring it back, because the plugin sent preset attributes the runtime refuses. The plugin now declares only the attributes of what the thermostat can do; if a Homebridge version does not accept that, it tries once more with the payload of 2.2.0 before falling back to a temperature sensor. (TH-01, MAT-01)
- Thermostats that an earlier version had saved as a temperature-sensor fallback get one automatic attempt to become thermostats again at the first start of 2.3.0, without `matterRecoveryRequests`. If Homebridge does not accept the thermostat, the temperature sensor comes back as before and no further automatic attempt is made. (TH-01)
- A heating output and a cooling output of the same Ksenia program no longer act on each other in Matter. The heating output shows Off while the program runs in summer (and the cooling output while it runs in winter), refuses a setpoint or Heat in that season instead of writing the summer setpoint or switching the whole program to winter, and does not forward Off (which would stop the cooling). The role comes from the program data, not from the device name: renaming a thermostat in `matterOverrides` or `customNames` no longer changes what it can do. (TH-05)
- A Matter command sent shortly after another one is no longer dropped as "already current" because the panel had not reported the first one yet (for example 26 °C and then back to 23 °C, or Off and then Heat, within two seconds). Two quick +1 °C steps now add up to +2 °C. (TH-08, F33)
- Matter thermostats no longer declare the Occupancy feature: the "unoccupied" setpoints, which the plugin never used, are gone. (TH-09)
- Matter thermostats publish whether the heating or cooling output is running (`thermostatRunningState`). (TH-10)
- A Matter thermostat whose room temperature has not been read yet shows it as unknown instead of a made-up 20 °C (or 0 °C). (F2 note on the thermostat path)
- Auto (and Cool) on a heating-only Matter thermostat is refused to the controller instead of being accepted and silently ignored. A cooling-only output refuses Heat and Auto the same way. (TH-15)
- A Matter thermostat command that cannot reach the panel (no connection) is reported as failed and the previous value comes back, instead of looking accepted. (TH-17, MAT-15)
- The Matter fallback store no longer rewrites a file it does not understand (a version written as text, an unknown layout): it is left untouched and the state is kept in memory. An unreadable file is copied to `klares4-matter-fallback.json.unreadable.bak` before the store starts again. A recovery in progress is no longer reported as "interrupted" by the plugin itself while it is still running. (TH-14)

- On the first start without a `.ksa` backup, the panel lists the outputs before the thermostat programs, so a thermostat was registered with the role its name suggested and kept that shape (for example heating and cooling on a heating-only output) until Homebridge restarted. The Matter thermostat is now replaced, keeping its identity, as soon as the program data gives the real role, and also when the program is changed on the panel. Panels that do not provide the programs keep the name-based role and are registered at once. (TH-05)
- On Homebridge versions that accept only the older thermostat payload, the plugin no longer has every thermostat refused and retried at each start: it remembers which payload worked and starts from it, and moves to the other payload by itself if Homebridge later refuses the remembered one. (TH-01)

### Changed
- Heating-only thermostats (and cooling-only ones, when the program data says so) are exposed to Matter with only that capability: no cooling slider, no Auto. Thermostats whose output does both keep heating, cooling and Auto. (TH-01, TH-05)

## Migration notes
- **Homebridge 2.5 users** (every thermostat was a temperature sensor): at the first start of 2.3.0 each thermostat in `klares4-matter-fallback.json` is removed as a temperature sensor and registered as a thermostat, once. In Apple Home / Alexa / Google the temperature sensor disappears and a thermostat appears (new accessory: rooms and automations that used the sensor must be set again). Watch the log for `was saved as a TemperatureSensor fallback by an earlier version; trying the native Thermostat once`. If it falls back again, the log says why; `matterRecoveryRequests` still allows another explicit attempt.
- **Users whose thermostats were native** (Homebridge versions that accepted the 2.2.0 payload): the cluster now has fewer features (no Occupancy, no Auto/Cooling on heating-only outputs). Homebridge sees a different endpoint shape in its cache and replaces the endpoint at the first start; controllers may show it as changed.
- The store file also records, for a thermostat registered with the older payload, `nativeShape: "legacy"` with its `nativeShapeRevision` (records with `mode: "native"`); a thermostat registered with the current payload adds nothing unless it already had a record. 2.2.0 ignores the field.
- The store file gains an optional field `nativeShapeRevision` (the Thermostat payload revision of the last native attempt). 2.2.0 reads the file unchanged (the field is kept as is).
- Without the program data (no `PRG_THERMOSTATS` and no `.ksa`), the plugin still decides heating-only vs heating-and-cooling from the name, as 2.2.0 did, until the discovery layer fills `outputRole` (see below).

## Integration

### Done in this task, in F1's files (after F1 was merged)
- `matter-registration-recovery.ts`: in `handleMissingRegisteredAccessory` (thermostat branch, before the TemperatureSensor fallback) and in `handleRegisterFailure` (thermostat, not transient) one line `if (await registerNextThermostatAttempt(reg, deps)) return;`; in `registerFallbackAccessory` `resetThermostatAttempts(device.id)`; `RecoveryDeps` gains the optional `thermostatEchoTracker`.
- `matter-registration-flow.ts`: `recoveryDeps()` passes `thermostatEchoTracker`.
- The attempt itself is `registerNextThermostatAttempt` in `matter-thermostat-attempts.ts`: rebuilds the cluster with the 2.2.0 payload, unregisters the refused endpoint, records the new payload as pushed (echo guard), registers and lets the probe decide. F1's strict probe checks the declared clusters (`thermostat`), so a heating-only Thermostat is queryable (tested on the real stack).
- Existing tests that modelled "Thermostat refused once → TemperatureSensor" now refuse both payloads (`matter-accessory-registry`, `matter-placeholder-initial-state`, `matter-registration-race`): the fallback is reached after the second attempt.

### Role known after the registration (first login without `.ksa`) and remembered payload

Two ways were possible for a thermostat registered before `PRG_THERMOSTATS` arrives: (a) hold its registration until the program data is known or known to be missing, or (b) replace the endpoint when the role changes. (b) is the one implemented: the registry does not know whether the panel will answer `PRG_THERMOSTATS` (some answer `CMD_NOT_AVAILABLE`), so (a) needs a protocol-level "programs final" signal and a timeout to avoid a registration left waiting, and the role can change at runtime anyway (program edited on the panel), which only (b) handles. What (b) does (`matter-registration-flow.ts`, `matter-thermostat-attempts.ts`):
- every state update of a registered native Thermostat compares the static attribute set of the live cluster (declared attributes and control sequence) with the one the device needs now; a difference means the role changed;
- the endpoint is replaced with F2's `replaceEndpoint(…, 'same-device')` (same output, still a thermostat: `uniqueId` kept) and registered again with the new attributes, in the registration gate; a role change seen while the registration was pending is checked when it completes;
- if the old endpoint cannot be removed, the registration stays as it is and is not tried again in the session.
On a panel with programs and no `.ksa`, the first start registers each thermostat once with the name-based role and replaces it once if the program says otherwise (the endpoint is absent for about a second). With the `.ksa` cache or from the second login the role is known at registration and nothing is replaced.

The payload that worked natively is remembered in the fallback store (`nativeShape`, `nativeShapeRevision`); each registry starts a thermostat from it (`startThermostatAttempts`) and moves to the other payload only if the runtime refuses it. A remembered payload of another revision is ignored.

### D (or integration) — fill `outputRole` and `status.season`
- `status.outputRole` from `PRG_THERMOSTATS` / the `.ksa` cache (D already does this in its branch). Only the panel's own name may be used as fallback, never a custom/Matter name.
- `status.season` from `ACT_SEA` (D already does this). Needed for the right Off/Heat on a heating output in `AUTO`, and for the running state of an output that does both.

### F2 — none required
`matter-device-mapper.ts` keeps calling `buildThermostatMatterState(device)`, `thermostatSupportsCooling(device)` and `buildThermostatHandlers({...})` with unchanged signatures. `supportsCooling` in the handler deps is now ignored (the handlers read the role from the latest snapshot); it can be dropped later. `domainModeToMatterMode` there duplicates `domainModeToMatterSystemMode`.

## Documentation notes (task L)
- `docs/MATTER_TROUBLESHOOTING.md` (EN/IT): the "fixed via the bitmap workaround" text about thermostat fallbacks is wrong since Homebridge 2.5. Replace with: the plugin registers the Thermostat with only the attributes of the output's role (Homebridge 2.5 derives the features from them), tries the 2.2.0 payload once if that is refused, then falls back; old fallbacks get one automatic attempt; `matterRecoveryRequests` for any further attempt. Mention the log lines quoted above and the `.unreadable.bak` copy.
- Thermostat page (EN/IT): one Ksenia program with a heating and a cooling output appears in Matter as two thermostats, heating-only and cooling-only; each shows Off out of its season and refuses commands there. On HAP nothing changes in this release.
- ARCHITECTURE: `matter-thermostat-role.ts` (role and season, pure), `matter-thermostat-shape.ts` (payload choice per UUID), `matter-thermostat-attempts.ts` (attempt chain), the ACK-confirmed values in `MatterThermostatEchoTracker`.

## To verify in the field (rc)
- A thermostat on the production bridge registers as Thermostat after the automatic recovery, and Apple Home / Alexa show heating only for heating outputs.
- Apple Home and Alexa behaviour on a heating output while the program is in summer (endpoint Off; a refused Heat comes back to Off).
- On a Homebridge 2.4.x bridge (CI matrix): whether the conformant payload is accepted, or the second attempt (log line `trying the payload of earlier versions`) is needed. If the second attempt is what works, every restart tries the conformant payload first again (the choice is per process).
