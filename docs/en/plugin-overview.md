# Plugin Overview

## Runtime Components

- `Lares4Platform`: Homebridge platform orchestrator (`src/platform/index.ts`)
- `KseniaWebSocketClient`: websocket facade (`src/websocket-client/index.ts`)
- `MqttBridge`: optional MQTT publish/command bridge (`src/mqtt-bridge/index.ts`)
- accessory handlers: HomeKit adapters under `src/accessories/*`

## Startup Sequence

1. Homebridge calls `didFinishLaunching`.
2. Platform initializes websocket client and starts discovery cycle.
3. If enabled, KSA import is executed before websocket connection.
4. Plugin logs in to Ksenia and requests initial data.
5. Devices are discovered and cached accessories are restored.
6. Realtime registration starts and updates become authoritative.

## Device Model

- Outputs are projected to:
  - `light_*`
  - `cover_*`
  - `gate_*`
  - `thermostat_*`
- Zones become `zone_*`.
- Scenarios become `scenario_*`.
- Bus environmental sensors become:
  - `sensor_temp_*`
  - `sensor_hum_*`
  - `sensor_light_*`

## Core Principles

- Realtime (`STATUS_*`) is preferred over static assumptions.
- Thermostat writes use `WRITE_CFG/CFG_ALL` only.
- Command routing is explicit and cached, not heuristic.
- Domus environmental telemetry and thermostat control routing are separate concerns.

## Internal Data Sources

- `MULTI_TYPES`: output/scenario/sensor discovery metadata
- `STATUS_OUTPUTS`: output runtime states
- `STATUS_BUS_HA_SENSORS`: Domus room telemetry
- `STATUS_SYSTEM`: panel system temperatures (fallbacks)
- `CFG_THERMOSTATS`: thermostat persisted config
- `STATUS_TEMPERATURES`: thermostat realtime operational state
- `PRG_THERMOSTATS` (when available): structural mapping (output <-> thermostat ID <-> Domus sensor)

## KSA Integration Summary

- `ksaImport` can parse a `.ksa` backup and derive:
  - thermostat command mapping (`output -> cfg thermostat ID`)
  - Domus sensor mapping (`output -> sensor ID`)
  - room mapping and optional custom names
- A sanitized cache is written to Homebridge storage:
  - `klares4-ksa-cache.json`
- Runtime can preload mapping from cache even if `PRG_THERMOSTATS` is unavailable on panel firmware.
