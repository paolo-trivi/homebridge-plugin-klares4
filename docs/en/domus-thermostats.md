# Domus Thermostats and KSA

## Problem Space

On some installations the following are not numerically aligned:

- the output thermostat IDs (`thermostat_20`, `thermostat_21`, ...),
- the DOMUS sensor IDs (`sensor_3`, `sensor_4`, ...),
- the thermostat configuration ID (`CFG_THERMOSTATS.ID`, the "program" the panel writes to).

Any implicit assumption (`output == sensor == cfg`) makes a command change the wrong room.

## Namespaces

The plugin treats these as three distinct namespaces:

| Namespace | Used for | Example |
|---|---|---|
| Output | HomeKit and Matter identity (`thermostat_<outputId>`) | `thermostat_21` |
| Thermostat configuration | The ID the panel accepts in `WRITE_CFG` (`CFG_THERMOSTATS.ID`) | `3` |
| DOMUS sensor | Room telemetry. `STATUS_TEMPERATURES.ID` is **this** ID, not the configuration ID | `4` |

## Command Routing (fail-closed)

To write to a thermostat the plugin needs its configuration ID. It takes the first of these that exists, and **never falls back to a guess once an explicit source fails**:

1. `domusThermostat.manualCommandPairs` (your explicit pair, or one written by the KSA import).
2. The panel's own `PRG_THERMOSTATS` program (live, or from the KSA cache).
3. A verified guess, only on panels without thermostat programs and without a pair: the DOMUS sensor ID, then the output ID, accepted only if the configuration read for that ID is coherent with what the thermostat reports in realtime.

A write is **refused with an error, and nothing is sent**, when:

- the ID from a pair or a program cannot be read from the panel (`cfg id X (from ... ) could not be read from the panel; write refused`);
- the output is not the heating or cooling output of any program on a panel that has programs;
- a guess does not match what the thermostat reports in realtime, or is ambiguous (two thermostats in exactly the same state cannot be told apart).

The error for a guess names the exact `manualCommandPairs` line to add.

## Write Forms

The plugin sends only what the command changes, in the same form as the official Ksenia web app, wrapped in `WRITE_CFG` / `CFG_ALL`:

| Command | Payload for the thermostat (`ID` = configuration ID) |
|---|---|
| Mode Off | `{ ID, ACT_MODE: "OFF" }` |
| Mode Heat | `{ ID, ACT_MODE: "MAN", ACT_SEA: "WIN" }` |
| Mode Cool | `{ ID, ACT_MODE: "MAN", ACT_SEA: "SUM" }` |
| Mode Auto | `{ ID, ACT_MODE: "AUTO" }` |
| Setpoint | `{ ID, WIN` or `SUM: <whole season block, re-read right before, with only TM changed> }` |
| Mode and setpoint together | One write with both parts, in the right order |

- A **setpoint** re-reads that thermostat's configuration right before writing and sends the active season's block with only the target temperature (`TM`) changed. It never sends a mode: with the thermostat Off it stays Off, in Auto the program stays active.
- The **season** comes from the realtime `ACT_SEA`, else from the configuration read; the freshest observation wins and an acknowledged write only counts until the panel shows otherwise. A "cool" the panel never confirmed does not move later setpoints to the summer season.
- Commands for the same thermostat are merged (the latest mode and the latest setpoint go out together), and two accessories that share one panel thermostat do not overwrite each other.
- The deadline is `commandTimeoutMs`; a write still queued after it is refused.
- The plugin notices configuration changes made on the panel (`NM_CHANGES` notifications, the `PRG_CHECK` counter) and re-reads a thermostat's configuration before using it again. Whether the panel sends these notifications for changes made on the keypad is still to be confirmed on a real panel; the re-read before every setpoint protects the write either way.
- A reconnection does not replay the configuration of the previous session over the live state.

## Realtime State Authority

`STATUS_TEMPERATURES` drives, per thermostat:

- mode (`off`, `heat`, `cool`, `auto`),
- target temperature (in Auto the target shown is always the program's),
- current activity (HomeKit "Current Heating/Cooling State": in Auto it follows the season),
- the active season.

An unknown realtime mode (anything but OFF, MAN, AUTO) is shown as heating or cooling according to the active setpoint, with one warning asking you to report the value.

The **current temperature** comes from the DOMUS sensor of the room. The panel's internal board temperature is used only for thermostats that have no temperature source at all, and only when it changes. `domusThermostat.sensorFreshnessMs` is how long a realtime thermostat reading takes precedence over the DOMUS sensor reading.

### Name matching between thermostats and DOMUS sensors

When no pair or program links a thermostat to a sensor, the plugin matches them by name. A sensor is shared only between **full** name matches (such as the heating and cooling outputs of the same room): a thermostat is never given the sensor of another room with a similar name.

## Heating and Cooling Outputs

One Ksenia program can have a heating output and a cooling output (the program data says which: `HEATING_OUT`, `COOLING_OUT`). Their role comes from the program, or, without program data, from the panel's own output name, never from a custom or Matter name.

- On **Matter** they appear as two thermostats, heating-only and cooling-only. The heating output shows Off while the program runs in summer (the cooling output while it runs in winter), refuses a setpoint or Heat in that season and does not forward Off (which would stop the other output).
- On **HomeKit** nothing changes in this release: each output is a thermostat with its own mode.

Without program data (no `PRG_THERMOSTATS` and no `.ksa` cache) the Matter side decides heating-only versus cooling from the name on the first login; with the `.ksa` cache or from the second login on, the role is known when the endpoint is registered.

## KSA Import

`ksaImport` parses the `.ksa` backup and builds:

- `manualCommandPairs` for command routing,
- `manualPairs` for room telemetry,
- optional room mapping and custom names.

The import **never replaces your own pairs**: the pairs you configured win, the backup only adds the thermostats you have not mapped, and an empty backup never empties your lists. When your pair differs from the backup, one log line names the thermostat and both values.

The plugin stores only sanitized data (`klares4-ksa-cache.json`); no raw `.ksa` payload is persisted.

## Typical Operational Flow

1. Set `ksaImport.enabled=true` and `filePath`.
2. Restart Homebridge.
3. Check the preview logs with the derived thermostat mappings.
4. Set `ksaImport.applyAtStartup=true` to persist the selected blocks in `config.json`.
5. Restart and validate thermostat commands against the Ksenia app: the right room changes, and weekly programs and comfort temperatures are untouched.
