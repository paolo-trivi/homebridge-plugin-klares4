# Domus Thermostats and KSA

## Problem Space

On some installations:

- output thermostat IDs (`thermostat_20`, `thermostat_21`, ...)
- Domus sensor IDs (`sensor_3`, `sensor_4`, ...)
- `CFG_THERMOSTATS.ID` / `STATUS_TEMPERATURES.ID`

are not numerically aligned.

Any implicit assumption (`output == sensor == cfg`) causes wrong room writes.

## Effective Routing Model

The plugin treats these as distinct namespaces:

- Output namespace: HomeKit identity (`thermostat_<outputId>`)
- Thermostat config namespace: panel control ID (`CFG_THERMOSTATS.ID`)
- Domus namespace: room telemetry sensor (`BUS_HAS.ID`)

## Resolution Priority

When resolving thermostat command ID:

1. `manualCommandPairs` (explicit)
2. `PRG_THERMOSTATS` live mapping
3. cached mapping from KSA sanitized cache
4. cached previously resolved command ID
5. degraded fallback candidates (`mappedDomusSensorId`, then output ID)

## Realtime State Authority

`STATUS_TEMPERATURES` drives:

- mode (`off`, `heat`, `cool`, `auto`)
- target temperature
- current HVAC activity

Domus room sensors keep room telemetry useful, but do not decide command routing.

## KSA Import

`ksaImport` parses `.ksa` backup and builds:

- `manualCommandPairs` for command routing
- `manualPairs` for room telemetry mapping
- optional room mapping and custom names

The plugin stores only sanitized data in:

- `klares4-ksa-cache.json`

No raw `.ksa` payload is persisted by the plugin.

## Typical Operational Flow

1. Set `ksaImport.enabled=true` and `filePath`.
2. Restart Homebridge.
3. Check preview logs with derived thermostat mappings.
4. Set `ksaImport.applyAtStartup=true` to persist selected blocks in `config.json`.
5. Restart and validate thermostat commands against Ksenia app.
