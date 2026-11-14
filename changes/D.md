# D — Thermostats: protocol and HAP

## Config keys

None added, renamed or removed. Changed meaning, no schema change needed beyond the descriptions:

- `commandTimeoutMs` now also applies to thermostat writes (`WRITE_CFG`) and to the cfg read that precedes them (it was a fixed 2.5 s). Schema/README description (EN): "Maximum wait for the panel's answer to a command, thermostats included." (IT): "Attesa massima della risposta della centrale a un comando, termostati compresi." (TD-DOC-06)
- `domusThermostat.sensorFreshnessMs` no longer decides when the panel's internal temperature replaces a thermostat's room temperature (TH-03). It is still read and still used by the existing DOMUS sensor → thermostat path (`status-updater.ts`). Description to update (EN): "How long a realtime thermostat reading takes precedence over the DOMUS sensor reading." (IT): "Per quanto tempo una lettura realtime del termostato prevale su quella del sensore DOMUS." The old wording ("after this time the STATUS_SYSTEM temperature is used") is no longer true.
- `temperatureDefaults.min` / `max` are now enforced on setpoints received from MQTT (refused outside the range) and on the value shown to HomeKit (SP-16, TH-13). Add to their description: "Also applied to MQTT setpoint commands." / "Vale anche per i comandi di setpoint MQTT."

## Changelog (2.3.0)

### Fixed
- Setting a thermostat temperature or mode no longer writes back the whole thermostat configuration read at login. A setpoint sent from HomeKit, Matter, Alexa or MQTT could switch heating back on after it had been turned off on the keypad (or off after it was turned on), drop a weekly program, and undo schedule, comfort-temperature, season or other changes made on the panel since the plugin connected. The plugin now sends only what the command changes, in the same form as the official Ksenia web app: a mode change sends only the mode (and the season for heat/cool), a temperature change re-reads that thermostat's configuration right before writing and sends only the active season's block with the new temperature. (TH-02, F20)
- The plugin notices configuration changes made on the panel (`NM_CHANGES` notifications) and re-reads a thermostat's configuration before using it again. (TH-02)
- A thermostat write is refused with a clear error, and nothing is sent, when the plugin cannot be sure which panel thermostat it belongs to: a `domusThermostat.manualCommandPairs` entry pointing to a thermostat the panel does not have, a configuration that cannot be read, an output that no thermostat program uses, or (on panels without thermostat programs) a guessed configuration that does not match what the thermostat reports live. Before, such writes could change another room's thermostat while reporting success. (TH-04, TH-17)
- Automatic thermostat ↔ DOMUS sensor matching by name no longer gives one room's sensor to another room with a similar name (e.g. "Zone Night" matched to the "Zone Day" sensor). A sensor is shared only between full name matches, such as the heating and cooling outputs of the same room. (TH-04)
- A reconnection no longer replays the thermostat configuration of the previous session over the live state: no more spurious heat → off transitions or AUTO targets jumping to the manual setpoint in HomeKit, Matter and MQTT at every reconnect. In AUTO the target shown is always the program's. (TH-06)
- A thermostat's current temperature is no longer replaced by the panel's internal board temperature when the room temperature simply stays the same for more than 5 minutes. The panel temperature is used only for thermostats that have no temperature source at all, and only when it changes. (TH-03)
- A temperature or mode changed from HomeKit (or by an MQTT command) now reaches Matter and the MQTT state topic as soon as the panel acknowledges it, instead of after the next unrelated change. (TH-07)
- HomeKit "Current Heating/Cooling State" in AUTO now follows the season: in winter with the heating output on it shows Heating, never Cooling. (TH-10)
- A mode and a temperature sent together (a HomeKit scene "Heat at 21 °C", a slider sending several values) become one panel write, applied in the right order whatever order HomeKit delivers them; two accessories sharing one panel thermostat no longer overwrite each other. (TH-12)
- An acknowledged "cool" that the panel never confirmed no longer moves later setpoints to the summer season. (TH-11)
- Panel setpoints outside the HomeKit limits (`temperatureDefaults.min`/`max`) are shown at the nearest limit instead of producing a HomeKit warning at every update. (TH-13)
- A thermostat realtime mode the plugin does not know (other than OFF/MAN/AUTO) is no longer shown as a frozen mode: with an active setpoint it is shown as heating/cooling, and one warning asks to report it. (TH-16)

### Security
- MQTT setpoints outside `temperatureDefaults.min`/`max` are refused with a warning instead of being written to the panel (any value from 5 to 40 °C was accepted). (SP-16)

### Changed
- Thermostat writes use `commandTimeoutMs` (default 8 s) instead of a fixed 2.5 s, and a temperature change is preceded by a read of that thermostat (≈250 ms on a real panel). (TD-DOC-06, TH-02)

## Migration notes
- No persisted data changes. HAP and Matter accessories, UUIDs, topics unchanged. Optional fields are added to the thermostat state (see below); they are persisted with the HAP cache and ignored by older versions.
- Panels without thermostat programs (`PRG_THERMOSTATS` answered with `CMD_NOT_AVAILABLE`) and without a KSA backup: a write whose guessed configuration does not match the thermostat's live state is now refused with an error naming `domusThermostat.manualCommandPairs`. Users who get it must add the pair (the error shows the exact line).
- `manualCommandPairs` entries pointing to a thermostat id the panel does not have now make every write of that thermostat fail visibly (before: silently written elsewhere). Fix the id.
- A thermostat output not used by any thermostat program on a panel that has programs is refused (before: the output id was written blindly as a cfg id).
- MQTT `targetTemperature` outside `temperatureDefaults.min`/`max` is refused.

## Documentation notes
- `docs/en|it/domus-thermostats.md`: describe the write forms (mode `{ID, ACT_MODE[, ACT_SEA]}`, setpoint `{ID, <WIN|SUM>: block}` after a re-read), the fail-closed routing order (manual pair → program → verified guess; never a fallback once an explicit id fails), the realtime coherence check of the degraded path and its limit (two thermostats in exactly the same state cannot be told apart), the sensor-uniqueness rule of the name matching, `NM_CHANGES` handling. Fix the old statement that `CFG_THERMOSTATS.ID` and `STATUS_TEMPERATURES.ID` share a namespace (the latter is the DOMUS sensor id).
- Troubleshooting: the new error messages "cfg id X (from …) could not be read from the panel; write refused", "is not the heating or cooling output of any PRG_THERMOSTATS program", "does not match what this thermostat reports in realtime", and the warning "Thermostat realtime mode ACT_MODEL=… is not known to the plugin".
- ARCHITECTURE: thermostat command path = `thermostat-command-service.ts` (validation, routing) → `thermostat-write-batcher.ts` (serialization per cfg id, merging) → `thermostat-write-executor.ts` (re-read, partial payload, ACK propagation); `thermostat-cfg-freshness.ts` (PRG_CHECK counter).

## Contract for task E (Matter thermostats), additive
`ThermostatStatus` (device `status`) gained, all optional:
- `season?: 'WIN' | 'SUM'`: active season (realtime `ACT_SEA`, else the cfg read). Updated through `updateThermostatStatus`, a change emits a status event.
- `outputRole?: 'heating' | 'cooling'`: from `PRG_THERMOSTATS` / KSA `HEATING_OUT` / `COOLING_OUT`. Absent when the panel has no programs (then fall back to the name).
- `observedAt?: number`: last STATUS_TEMPERATURES for this thermostat (epoch ms).
- `acknowledged?: { mode?, targetTemperature?, at }`: what the last acknowledged write of its cfg contained. Use it, when `at > observedAt`, as the base for idempotence and raise/lower (TH-08). Set on every thermostat sharing the cfg.
- After an ACK, when the client is given `emitDeviceStatusUpdate` (see requests), `mode`/`season` and, only when it is the live one (MAN in the season written), `targetTemperature` are updated and one status event is emitted: Matter receives it like a realtime change.
- `setThermostatMode` / `setThermostatTemperature` now reject (TypeError) invalid modes and non-finite setpoints, and reject `ThermostatRoutingError` when the routing is not certain; the promise settles with the outcome of the merged write.

## Hooks requested from other tasks (not done: files not mine)
1. **C — `message-service.ts`**, `handleMessage` (or the router's `onUnhandled` in `index.ts`): route the panel's change notification, one line, e.g. in `handleMessage` before routing:
   `if (message.CMD === 'NOT_MASK_UNSOLICITED') runIsolated(this.deps.log, 'NM_CHANGES', () => this.thermostats.handleChangeNotification(message.PAYLOAD));`
   (NM_CHANGES arrives with `ID: "0"`, `PAYLOAD: { PRG_CHECK: { PRG, CFG } }`.) Until then only the fixed re-read before setpoints protects against keypad changes; mode writes do not need the cache contents.
2. **C — `message-service.ts`** `handleReadResponse`: pass the counter, `this.thermostats.handleCfgThermostats(cfg, payload.PRG_CHECK)` (every READ_RES carries it). Without it the first NM_CHANGES after login always clears the cache (harmless: one extra read).
3. **B — `command-service.ts`** + **C — `index.ts`**: give the thermostat service the status channel: in `CommandServiceDeps` add `emitDeviceStatusUpdate?: (device: KseniaDevice) => void`, pass it to `new ThermostatCommandService({ …, emitDeviceStatusUpdate: deps.emitDeviceStatusUpdate })`; in `index.ts` pass `emitDeviceStatusUpdate: (device) => this.emitStatus(device)` to `new CommandService`. Without it the ACK is not propagated at once (the realtime ~2 s later still is, since the HAP accessory no longer mutates the shared state).
4. **B — queue primitive**: my `ThermostatWriteBatcher` takes `enqueue(key, task)`; today it is the dispatcher's `enqueueDeviceCommand(key, task)` with key `thermostat-cfg:<id>`. After B is integrated, the switch is local to `thermostat-command-service.ts`: `enqueue: (key, task) => deps.commandDispatcher.enqueueDeviceCommand(key, task, { policy: 'serial', maxWaitMs: <commandTimeoutMs> })`. Use `serial`, not `latest-wins`: merging happens before enqueueing (at most one running and one waiting job per cfg), and the waiting job is the merged one, so nothing must be dropped as superseded. B's primitive alone cannot merge two writes into one (it replaces or rejects whole tasks), hence the batcher on top.
5. **C** (`state.ts`): optionally initialise `thermostatCfgFreshness` there; today it is created lazily by `thermostat-cfg-freshness.ts`.

## To verify on the field (rc, the user only; no agent sends commands)
Run with `generateDebugFile: true` (capture) and debug log. For each step note the HomeKit action, then in the capture look at the `WRITE_CFG` sent, the `WRITE_CFG_RES`, the following `READ_RES CFG_THERMOSTATS` (if any) and the realtime `STATUS_TEMPERATURES`.
1. **Partial setpoint write merges at the top level.** Thermostat in MAN winter. On the keypad change the comfort temperature T1 (or a time slot of today). From HomeKit set 21.5 °C. Expected: `WRITE_CFG` = `{ID, WIN:{…whole block…, TM:"21.5"}}` (no ACT_MODE/ACT_SEA/SUM/TOF/MAN_HRS), `WRITE_OK`, realtime `TEMP_THR.VAL` 21.5, and on the keypad T1/slot still as set on the keypad, the mode unchanged.
2. **Setpoint on OFF and AUTO.** Switch the thermostat OFF on the keypad; from HomeKit set 22 °C. Expected: panel stays OFF (realtime `ACT_MODEL: OFF`), WIN.TM 22.0 on the keypad. Same with AUTO selected on the keypad: program kept.
3. **Mode writes.** From HomeKit Off, then Heat. Expected `{ID, ACT_MODE:"OFF"}` then `{ID, ACT_MODE:"MAN", ACT_SEA:"WIN"}`, both `WRITE_OK`, setpoint and schedule untouched. **Cool** (`ACT_SEA:"SUM"` together with ACT_MODE) has never been observed from the official app: in summer try Cool once and check realtime `ACT_SEA: SUM`, `ACT_MODEL: MAN`.
4. **Scene.** HomeKit scene "Heat + 21 °C" on a thermostat OFF: expected ONE `WRITE_CFG` `{ID, ACT_MODE:"MAN", ACT_SEA:"WIN", WIN:{…, TM:"21.0"}}`, `WRITE_OK`, realtime MAN 21.0.
5. **NM_CHANGES for keypad changes.** Change anything on a thermostat from the keypad (or the Ksenia app) while the plugin is connected; look for `NOT_MASK_UNSOLICITED / NM_CHANGES` within a few seconds and whether `PRG_CHECK.CFG` grew by 1. If it never arrives for keypad changes, NM_CHANGES only covers web/app writes (the re-read before setpoints still protects).
6. **Unknown modes.** If the panel has a timed manual / special day: activate it and check the realtime `ACT_MODEL` value and whether the warning "ACT_MODEL=… is not known" appears; report the value.
7. **Degraded panels only** (no `PRG_THERMOSTATS`): every thermostat should still accept writes; an error naming `manualCommandPairs` means the guess did not match the live state.
8. MQTT: `{"targetTemperature": 5}` with `temperatureDefaults.min: 16` → warning, nothing in the capture.
