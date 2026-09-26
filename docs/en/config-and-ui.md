# Configuration and UI

## Core Required Fields

- `ip`
- `pin`
- optional `port`, `https`, `allowInsecureTls`

Leave `port` unset: the plugin then uses 443 with `https` (the default) and 80 without. An explicit `port` is always used as-is, so `https: false` with `port: 443` does not connect.

## Reliability and Logging

- `logLevel`:
  - `0` minimal
  - `1` normal
  - `2` debug
- `commandTimeoutMs`
- `reconnectInterval`
- `heartbeatInterval`

The legacy `debug: true` only applies when `logLevel` is absent. The Homebridge UI writes every top-level default on save, including `logLevel: 1`, so use `logLevel: 2` for debug logging.

## Domus Thermostat Block

`domusThermostat` options:

- `enabled`
- `sensorFreshnessMs`
- `manualPairs` (`output -> Domus sensor`)
- `manualCommandPairs` (`output -> thermostat cfg ID`), array of `{ thermostatOutputId, commandThermostatId }`; written by the KSA import and editable in the UI

## KSA Import Block

`ksaImport` options:

- `enabled`
- `filePath` (absolute `.ksa` path)
- `applyAtStartup`
- `applyDomusMappings`
- `applyRoomMapping`
- `applyCustomNames`
- `applyExclusionSuggestions`

Behavior:

- On startup, if enabled and file exists:
  - parse `.ksa`
  - log summary preview
  - apply runtime overrides in-memory
  - write sanitized cache
- If `applyAtStartup=true`, selected sections are persisted to `config.json` and flag is reset to `false`. `config.json` is rewritten atomically (temp file + rename) and keeps its formatting.

What each section does, at runtime and when persisted:

- `applyDomusMappings` (default on): sets `domusThermostat.manualPairs` and `manualCommandPairs` from the backup.
- `applyRoomMapping` (default on): panel room names are turned into MQTT-safe slugs (`Sala / Pranzo` becomes `sala_pranzo`). Panel rooms are used only when you have not defined any room yourself; your rooms are never replaced. The import never switches `roomMapping.enabled` on, because that changes every MQTT topic: enable it yourself.
- `applyCustomNames`: panel names are added per device; a device you already named keeps your name. The result is written in the array form.
- `applyExclusionSuggestions`: suggested IDs are added to your `exclude*` lists and never replace them (the parser currently suggests none).
- An invalid or incomplete `klares4-ksa-cache.json` is ignored with a warning; re-run the import to rebuild it.

## Device Visibility and Naming

- `excludeOutputs`
- `excludeZones`
- `excludeSensors`
- `excludeScenarios`

Exclusion lists take the numeric ID without prefix (`37` for `light_37`, `5` for `zone_5`). A DOMUS sensor ID hides all three of its readings; the panel's own temperature readings are excluded with `sensor_system_temp_in` / `sensor_system_temp_out`. The startup summary prints both the device ID and the value to use here (`exclude:`).

Alarm scenarios:

- Scenarios that arm or disarm the alarm (ARM/DISARM) are never exposed.
- `exposePartialArmScenarios` (boolean, default `false`): when `false`, scenarios of category `PARTIAL` (partial arm) are not exposed to HomeKit, Matter or MQTT and cannot be triggered. Set it to `true` only if you accept that anyone who can operate the switch (voice assistants, scenes, automations, MQTT) can partially arm the alarm without a PIN prompt.
- `customNames` renames devices for HomeKit, MQTT and Matter; use the array form (`{ deviceId, name }`, e.g. `light_18`, `zone_3`, `sensor_1`, or `sensor_system_temp_in` whose name is used as-is), which the Homebridge UI preserves — the legacy per-category map is still read but dropped when the UI rewrites config.json. A KSA import with `applyCustomNames` writes the array form
- `matterExposure` hides whole categories from Matter only
- `matterOverrides` applies per-device Matter-only `name` / `exposed` values; use the array form (`{ deviceId, name, exposed }`), which the Homebridge UI preserves — a map keyed by device ID is dropped when the UI rewrites config.json
- `matterRecoveryRequests` is an array of `{ deviceId, generation }`: a `thermostat_*` ID and a positive generation that only ever increases. Rows without a `deviceId` or a valid `generation` are ignored (older schemas made the UI write an empty `{ "generation": 1 }` row on every save; it is harmless)
- `matterUnregisterTimeoutMs` (default 3000, 500-30000): how long the plugin waits for a removed Matter endpoint to really disappear before giving up and keeping the current name

Exposure precedence is: global exclusion, per-device override, category, then the existing default (`true`). Matter overrides never alter HAP/HomeKit or MQTT. In the UI the per-row "Exposed on Matter" box is ticked by default: untick it to hide the device, and note that a ticked row keeps the device exposed even when its category is off. A UI save on 2.2.0-rc.3 or earlier wrote `exposed: false` on every override row; the plugin now lists hidden devices in a startup warning.

A thermostat recovery generation is consumed once and persisted before the topology mutation. Increment it only for a deliberate retry. Failed or interrupted recovery rolls back to the read-only TemperatureSensor fallback; do not delete the fallback store.

## Room Mapping

- `roomMapping.enabled`
- `roomMapping.rooms[]`
- each room has `roomName` and `devices[].deviceId`

`roomName` must match `^[a-z0-9_]+$`: it becomes a level of the MQTT topic.

KSA import can generate the rooms from `PRG_ROOMS + PRG_MAPS` when you have none (see above); it slugs the panel names and leaves `enabled` as you set it.

## Telemetry

- `telemetry` (boolean, default: `true`)

Telemetry is on by default and sends anonymous error reports via Sentry. Opt out with `telemetry: false`.

- Only errors the plugin reports itself at explicit points are sent (currently a failed platform start-up or connection initialisation): error type, message, stack trace, plugin version and a short context label.
- There is no global capture of crashes or unhandled exceptions, and no analytics or usage data.
- Every event is sanitized first: the configured PIN, panel IP/host and sender, URLs and IPv4 addresses are scrubbed from the text; fields such as names, rooms, devices, configuration and payloads are dropped. Stack frames can include the plugin's installation path.
