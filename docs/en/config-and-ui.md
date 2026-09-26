# Configuration and UI

## Core Required Fields

- `ip`
- `pin`
- optional `port`, `https`, `allowInsecureTls`

## Reliability and Logging

- `logLevel`:
  - `0` minimal
  - `1` normal
  - `2` debug
- `commandTimeoutMs`
- `reconnectInterval`
- `heartbeatInterval`

## Domus Thermostat Block

`domusThermostat` options:

- `enabled`
- `sensorFreshnessMs`
- `manualPairs` (`output -> Domus sensor`)
- `manualCommandPairs` (`output -> thermostat cfg ID`)

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
- If `applyAtStartup=true`, selected sections are persisted to `config.json` and flag is reset to `false`.

## Device Visibility and Naming

- `excludeOutputs`
- `excludeZones`
- `excludeSensors`
- `excludeScenarios`
- `customNames` renames devices for HomeKit, MQTT and Matter; use the array form (`{ deviceId, name }`, e.g. `light_18`, `zone_3`, `sensor_1`), which the Homebridge UI preserves — the legacy per-category map is still read but dropped when the UI rewrites config.json. A KSA import with `applyCustomNames` writes the array form
- `matterExposure` hides whole categories from Matter only
- `matterOverrides` applies per-device Matter-only `name` / `exposed` values; use the array form (`{ deviceId, name, exposed }`), which the Homebridge UI preserves — a map keyed by device ID is dropped when the UI rewrites config.json
- `matterRecoveryRequests` maps a `thermostat_*` ID to a monotonic positive generation

Exposure precedence is: global exclusion, per-device override, category, then the existing default (`true`). Matter overrides never alter HAP/HomeKit or MQTT. In the UI the per-row "Exposed on Matter" box is ticked by default: untick it to hide the device, and note that a ticked row keeps the device exposed even when its category is off. A UI save on 2.2.0-rc.3 or earlier wrote `exposed: false` on every override row; the plugin now lists hidden devices in a startup warning.

A thermostat recovery generation is consumed once and persisted before the topology mutation. Increment it only for a deliberate retry. Failed or interrupted recovery rolls back to the read-only TemperatureSensor fallback; do not delete the fallback store.

## Room Mapping

- `roomMapping.enabled`
- `roomMapping.rooms[]`
- each room has `roomName` and `devices[].deviceId`

KSA import can auto-generate room mapping from `PRG_ROOMS + PRG_MAPS`.

## Telemetry

- `telemetry` (boolean, default: `true`)

The plugin automatically and anonymously collects technical errors (crashes, unhandled exceptions) via Sentry to help identify and fix bugs.
The feature applies strict sanitization before sending any data: it NEVER transmits your PIN, the panel IP address, URLs, tokens, client IPs, configuration objects, or custom device names.
If you prefer not to send any error reports, you can opt out by setting `telemetry: false` in your configuration.
