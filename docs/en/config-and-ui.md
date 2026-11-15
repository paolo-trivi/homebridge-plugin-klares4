# Configuration and UI

The complete list of keys, with type, default and limits, is the table in the [README](../../README.md#configuration-parameters). It is generated from the same facts as `config.schema.json` (the settings form) and a test keeps the two equal. This page explains how the values are read and how the groups of options work together.

## How Values Are Read

The raw Homebridge configuration is interpreted in one place, at startup, and the rest of the plugin only sees the validated result.

- **On/off options** need a real JSON `true` or `false`. An option whose default is `false` is on only for `true`; one whose default is `true` is off only for `false`. Any other value (`"true"`, `"false"`, `0`, `1`, an object) is ignored, the safe default applies, and one warning names the key and the type it received. In particular `"allowInsecureTls": "false"` keeps certificate verification on.
- **Numbers** must be numbers (integers where the table says integer). A value that is not a number, not finite or not an integer falls back to the default; a value outside the limits is moved to the nearest limit. The limits are the ones in the README table and in the settings form; the plugin enforces them itself, so a hand-edited `config.json` cannot make it reconnect hundreds of times per second.
- **Lists** must be lists. A value that is not a list is ignored with a warning; an entry that is not valid for its list is dropped and named.
- **Per-device settings are arrays of objects** (`customNames`, `matterOverrides`, `matterRecoveryRequests`, `exposeOutputs`, `exposeScenarios`): the Homebridge settings UI rebuilds `config.json` from its form and silently drops objects keyed by device ID. The legacy map form of the first three is still read and checked like the array form, but it does not survive a save from the UI.
- Problems are reported **once at startup**, grouped in one warning (`Configuration: N value(s) ignored or adjusted`), and never print the PIN, the MQTT password or the panel address. A `pin` that is neither a string nor a number is an error and the plugin does not start.
- Keys that were removed from the plugin (`telemetry`, `ksaImport.applyExclusionSuggestions`) are accepted in an existing `config.json` and ignored; delete them when convenient.

After the first synchronization one warning lists the `matterOverrides`, `matterRecoveryRequests` and `customNames` entries that match no device on the panel, with a hint when the ID is only a number (`1` instead of `zone_1`) or in capitals.

### Device ID forms

| Where | Accepted |
|---|---|
| `customNames`, `matterOverrides`, `matterRecoveryRequests` | Device IDs: `zone_1`, `light_5`, `cover_7`, `gate_9`, `thermostat_18`, `scenario_2`, `sensor_temp_3`, `sensor_hum_3`, `sensor_light_3`, and `sensor_system_temp_in` / `sensor_system_temp_out`. `customNames` also accepts `sensor_<id>` for all three readings of a DOMUS sensor |
| `excludeZones`, `excludeOutputs`, `excludeSensors`, `excludeScenarios` | A bare number (`5`, `"5"`, `" 5"`) or the full device ID (`"gate_5"`, `"light_5"`, `"zone_3"`, `"scenario_2"`, `"sensor_temp_1"`); the panel's own sensors are `sensor_system_temp_in` / `sensor_system_temp_out`. The comparison is exact |
| `exposeOutputs[].outputId`, `exposeScenarios[].scenarioId` | The numeric panel ID (`"12"`); `light_12`, `output_12` and `scenario_4` also work |

The startup summary prints, for every device, both its ID and the value to use in the `exclude*` lists (`exclude:`).

## Connection

- `ip` and `pin` are required; `port`, `https`, `sender` and `allowInsecureTls` are optional.
- Leave `port` unset: the plugin uses 443 with `https` (the default) and 80 without. An explicit `port` is used as it is, so `https: false` with `port: 443` does not connect.
- `allowInsecureTls` turns off the check of the panel's certificate and allows the legacy TLS renegotiation that most panels need. It is on only for the JSON value `true`. Use it on a trusted local network, when the log asks for it.
- The PIN is stored in clear text in `config.json`. Use a dedicated panel user.

## Reliability and Logging

- `reconnectInterval` is the base of an exponential backoff (ceiling 60 s, with jitter). It restarts after a complete synchronization.
- `heartbeatInterval` sets the keep-alive ping; a connection with no answer for two intervals is dropped and pending commands fail at once.
- `commandTimeoutMs` is the maximum wait for the panel's answer to a command, thermostats included. A command still queued after this time is refused.
- `logLevel` and `debug`: level `2` turns on the detailed trace of the plugin (commands sent to the panel, discovery and thermostat details). Those lines are written at Homebridge's **debug** level, so you see them only when Homebridge runs in debug mode (`-D`). Levels `0` and `1` currently behave the same. `debug` is a legacy switch that adds a few detail lines at the same level; it stands in for `logLevel: 2` only when `logLevel` is absent from `config.json`, which the settings UI never leaves.

## Exposure and Selection

- Outputs of an unrecognized category and scenarios of an unknown category are hidden. `exposeOutputs` (`[{ outputId, exposeAs }]`, `exposeAs` is `light`) and `exposeScenarios` (`[{ scenarioId }]`) opt individual devices in. The startup log prints the exact entries. Details in the README, [Exposure policy](../../README.md#exposure-policy-fail-closed).
- `exposePartialArmScenarios` (default `false`): scenarios of category `PARTIAL` are neither exposed nor runnable until you turn it on. `ARM` and `DISARM` are never exposed.
- `excludeOutputs`, `excludeZones`, `excludeSensors`, `excludeScenarios` remove devices from HomeKit, Matter **and MQTT** (a device's state is not published and it cannot be commanded). A DOMUS sensor ID hides all three of its readings.
- `customNames` renames devices for HomeKit, MQTT and Matter. A KSA import with `applyCustomNames` writes the array form.

## Matter Settings

- `matterExposure` turns off whole types on Matter only.
- `matterOverrides` sets a per-device Matter-only `name` and/or `exposed`. In the settings UI "Exposed on Matter" is ticked by default: untick it to hide the device. A ticked row keeps the device exposed even when its type is off in `matterExposure`.
- `matterRecoveryRequests` is an array of `{ deviceId, generation }`: a `thermostat_*` ID and a generation of at least 1 that only ever increases. Rows without a valid `deviceId` or `generation` are ignored.
- `matterUnregisterTimeoutMs` (default 3000, 500-30000) is how long the plugin waits for a removed endpoint to really disappear.
- Precedence of exposure: exclusion lists, then per-device `exposed`, then the type in `matterExposure`, then the default (exposed). Matter settings never alter HomeKit or MQTT.

See [Matter](./matter.md).

## Thermostat Settings

- `temperatureDefaults` (`target`, `min`, `max`, `step`) sets the range and the step of the HomeKit (HAP) thermostat, and the range that MQTT setpoints must respect. Matter thermostats use fixed ranges (heating 5-30 °C, cooling 16-35 °C). `step` is 0.5 or 1.
- `maxSeconds` and `coverStepSize` apply to HomeKit covers only; on Matter the cover shows the position the panel reports.
- `domusThermostat.enabled`, `sensorFreshnessMs`, `manualPairs` and `manualCommandPairs`: see [Domus Thermostats and KSA](./domus-thermostats.md).

## KSA Import Block

`ksaImport` options: `enabled`, `filePath` (absolute `.ksa` path), `applyAtStartup`, `applyDomusMappings`, `applyRoomMapping`, `applyCustomNames`.

Behavior:

- On startup, if enabled and the file exists, the plugin parses the `.ksa`, logs a summary preview, applies runtime overrides in memory and writes the sanitized cache.
- With `applyAtStartup: true`, the selected sections are persisted to `config.json` and the flag is reset to `false`. `config.json` is rewritten atomically, keeps its formatting and, if it is a symbolic link, stays one.
- If the write cannot happen, the plugin says so, leaves the flags as they were and retries at the next start.
- With more than one `Lares4Complete` block in `config.json`, the block of the running instance is updated (matched by `name`, then `ip`); if it cannot be told apart nothing is written and a warning explains how to fix it.

What each switch does:

- `applyDomusMappings` (default on): **adds** the thermostat mappings of the backup that are missing. The `manualPairs` and `manualCommandPairs` you configured always win, and an empty backup never empties your lists. When one of your pairs differs from the backup, one log line names the thermostat and both values.
- `applyRoomMapping` (default on): panel room names become MQTT-safe slugs (`Living / Dining` becomes `living_dining`). They are used only when you defined no room yourself. The import never switches `roomMapping.enabled` on, because that changes every MQTT topic.
- `applyCustomNames`: panel names are added per device; a device you already named keeps your name. The result is written in the array form.
- An invalid or incomplete `klares4-ksa-cache.json` is ignored with a warning; run the import again to rebuild it.

## Room Mapping

- `roomMapping.enabled` and `roomMapping.rooms[]`; each room has `roomName` and `devices[].deviceId`.
- `roomName` must match `^[a-z0-9_]+$`: it becomes a level of the MQTT topic.
- With room mapping on, a command on `<prefix>/<room>/<type>/<id>/set` runs only for a device of that room.
- The KSA import can generate rooms from the panel when you have none; it never turns `enabled` on.

## Settings Form (Homebridge UI)

- The form is in English. Its layout reaches every key of the schema, including the fields inside lists, because the UI deletes any key it cannot show the next time you save.
- Arrays of objects (names, overrides, opt-ins, pairs, rooms) have one row per entry; the empty row the UI adds is ignored.
- `showAdvanced` only unlocks the advanced parameters in the form; the plugin ignores it.
