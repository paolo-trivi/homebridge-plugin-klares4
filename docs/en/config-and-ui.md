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
- `customNames` for outputs, zones, sensors, scenarios

## Room Mapping

- `roomMapping.enabled`
- `roomMapping.rooms[]`
- each room has `roomName` and `devices[].deviceId`

KSA import can auto-generate room mapping from `PRG_ROOMS + PRG_MAPS`.
