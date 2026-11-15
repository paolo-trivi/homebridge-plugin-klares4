# Plugin Overview

## Runtime Components

- `Lares4Platform`: Homebridge platform orchestrator (`src/platform/index.ts`).
- `KseniaWebSocketClient`: WebSocket facade, the only module that talks to the panel (`src/websocket-client/index.ts`).
- `MqttBridge`: optional MQTT publish/command bridge (`src/mqtt-bridge/index.ts`).
- Accessory handlers: HomeKit adapters under `src/accessories/*`.
- Matter subsystem: registry, topology coordinator, name service and thermostat handlers under `src/platform/matter-*`.
- `DebugCaptureManager`: raw-traffic capture with redaction (`src/debug-capture/index.ts`).

The module map and the boundaries between layers are in [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Startup and Synchronization

1. Homebridge calls `didFinishLaunching`. The configuration is validated once: wrong types and out-of-range numbers are corrected and reported in one warning (see [Configuration and UI](./config-and-ui.md)).
2. If enabled, the KSA import runs before the connection.
3. The plugin opens the WebSocket (subprotocol `KS_WSOCK`) and logs in.
4. **Each login is a synchronization of its own**: discovery reads (zones, outputs, scenarios, DOMUS sensors), status reads, thermostat reads, then the realtime registration. See [WebSocket Protocol](./websocket-protocol.md).
5. The synchronization is complete only when the panel accepted the realtime registration. Then the HomeKit and Matter name maps are finalized and stale accessories are pruned.
6. Realtime changes (`STATUS_*`) become authoritative. A reconnection starts a new synchronization.

The log prints one summary of the discovered devices with their IDs, and again only when the list of devices changes.

## Device Model

Outputs and scenarios are classified before anything is exposed. What the plugin does not recognize is **not exposed** (fail-closed policy):

- Outputs: `LIGHT` becomes `light_*`, `ROLL` becomes `cover_*`, `GATE` with mode `M` becomes `gate_*` (other modes: `cover_*`), thermostat categories become `thermostat_*`. Any other output (`GEN`, `IRR`, no category) is hidden unless listed in `exposeOutputs`, which exposes it as `light_*`.
- Zones become `zone_*`.
- Scenarios become `scenario_*` when the panel lists them as `GEN`. `ARM` and `DISARM` are never exposed; `PARTIAL` only with `exposePartialArmScenarios`; unknown or missing categories only through `exposeScenarios`.
- DOMUS bus sensors become `sensor_temp_*`, `sensor_hum_*` and `sensor_light_*`; the panel's own temperatures are `sensor_system_temp_in` and `sensor_system_temp_out`.

A device that is hidden or excluded is removed from HomeKit at the first synchronization and from Matter after three complete synchronizations, is not published on MQTT and cannot be commanded.

## Core Principles

- Realtime (`STATUS_*`) is preferred over static assumptions.
- A command is `requested`, `sent`, then `acknowledged` (`RESULT=OK`) or `state-confirmed` (the output really changed). A socket write is never a success.
- Thermostat writes send only what the command changes (`WRITE_CFG`), never the whole configuration read at login.
- Thermostat command routing is explicit and fail-closed: if the right panel thermostat cannot be established, the write is refused.
- DOMUS room telemetry and thermostat command routing are separate concerns.
- Matter topology is decided by what the plugin observes, not by the return value of a register call.

## Data Sources

- `MULTI_TYPES`: outputs, scenarios and DOMUS sensors (discovery).
- `ZONES`: zones (discovery).
- `STATUS_OUTPUTS`, `STATUS_ZONES`, `STATUS_BUS_HA_SENSORS`: runtime state.
- `STATUS_SYSTEM`: the panel's own temperatures.
- `CFG_THERMOSTATS`: persisted thermostat configuration, re-read before a setpoint write.
- `STATUS_TEMPERATURES`: realtime thermostat state, indexed by DOMUS sensor ID.
- `PRG_THERMOSTATS` (when the firmware has it): structural mapping output, thermostat ID, DOMUS sensor and heating/cooling role.

## KSA Integration Summary

- `ksaImport` can parse a `.ksa` backup and derive the thermostat command mapping (`output -> cfg thermostat ID`), the DOMUS sensor mapping (`output -> sensor ID`), room mapping and optional custom names.
- The `.ksa` file is treated as untrusted input (numeric IDs only, names cut to 64 characters, at most 32 MB).
- A sanitized cache is written to the Homebridge storage folder (`klares4-ksa-cache.json`). The runtime can preload the mapping from it even if `PRG_THERMOSTATS` is unavailable on the firmware. No raw `.ksa` payload is stored.

## Files the Plugin Writes

All in the Homebridge storage folder. Files created for the first time are private (`0600`).

| File | Content |
|---|---|
| `klares4-devices.json` | The discovered devices with their IDs |
| `klares4-room-mapping-example.json` | An example `roomMapping` block; written at the first synchronization and when the list of devices changes |
| `klares4-ksa-cache.json` | Sanitized data derived from the `.ksa` backup |
| `klares4-matter-names.json` | The computed Matter names (version 2). Names of devices still on the panel never expire; the name of a missing device is reserved for 30 days |
| `klares4-matter-fallback.json` | Thermostats that fell back to a temperature sensor, and the Thermostat payload revision of the last native attempt |
| `klares4-matter-prune.json` | Consecutive-miss counters of the Matter prune |
| `klares4-debug-<timestamp>.json` | The debug file (confidential), only when `generateDebugFile` is on |

`config.json` is changed only by the debug-file switch and by an explicit KSA `applyAtStartup`. A symbolic link stays a link; if the file cannot be replaced atomically (a single-file Docker bind mount, `EBUSY`) the plugin rewrites it in place and logs a warning.
