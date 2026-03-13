# Operations and Troubleshooting

## Fast Validation Checklist

1. Set `logLevel=2`.
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
