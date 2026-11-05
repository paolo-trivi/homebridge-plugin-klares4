# Operations and Troubleshooting

## Fast Validation Checklist

1. Set `logLevel=2` (the legacy `debug: true` is ignored once the Homebridge UI has saved `logLevel`).
2. Restart Homebridge and verify:
   - `Response received: MULTI_TYPES`
   - `Response received: STATUS_OUTPUTS`
   - `Response received: CFG_THERMOSTATS`
   - realtime registration with `STATUS_TEMPERATURES`
3. Validate one thermostat command and confirm correct room changes in Ksenia app.

## Common Symptoms

### Thermostat changes wrong room

Likely routing mismatch between output and `CFG_THERMOSTATS.ID`.

Actions:

- Enable `ksaImport` with valid `.ksa`.
- Check debug lines:
  - `thermostat_<output> => cfg:<id> domus:<id> source:<...>`
- Re-test with setpoint up/down and mode switch.

### Startup states do not sync

Actions:

- verify `STATUS_TEMPERATURES` is present in register ACK / realtime changes
- verify `CFG_THERMOSTATS` read is successful
- verify no repeated reconnect/login loops

### PRG_THERMOSTATS unavailable

Some firmware responds with command unavailable.

Actions:

- rely on KSA sanitized cache preload
- confirm cache file exists under Homebridge storage

## Debug Capture File

- `generateDebugFile: true` records the raw WebSocket traffic at the next start and writes `klares4-debug-<timestamp>.json` in the Homebridge storage folder, with PINs masked. The flag resets itself to `false` in `config.json`.
- `debugCaptureDurationMs` (default 60000, range 10000-1800000) sets the length of the capture. On Matter-only setups where Apple Home needs minutes to respond after a child-bridge restart, raise it to 300000-600000.
- Reproduce the problem from the Ksenia app or from HomeKit while the capture runs. If Homebridge stops or restarts before the capture ends, the file is written at shutdown with what was recorded so far.

## Debug Script

The repository includes:

- `scripts/debug-thermostat-routing.js`

Use it to inspect:

- outgoing thermostat write payload IDs
- incoming `CFG_THERMOSTATS` and `STATUS_TEMPERATURES`
- post-write behavior in realtime

## Safety Notes

- Never commit raw `.ksa` backups with sensitive data.
- Plugin cache is sanitized by whitelist extraction.
- Keep `allowInsecureTls=false` unless strictly required in trusted LAN.
