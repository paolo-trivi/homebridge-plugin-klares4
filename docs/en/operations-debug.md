# Operations and Troubleshooting

## Fast Validation Checklist

1. Set **Log Level** to `2`: the detailed lines are written at info level, marked `[debug]`, so Homebridge does not have to run in debug mode (`-D`). Put it back to `1` afterwards: at level 2 every state change the panel reports is a log line.
2. Restart Homebridge and verify:
   - `Response received: MULTI_TYPES`
   - `Response received: STATUS_OUTPUTS`
   - `Response received: CFG_THERMOSTATS`
   - the realtime registration with `STATUS_TEMPERATURES`
   - one device summary, and no `Configuration: ... value(s) ignored or adjusted` warning
3. Validate one thermostat command and confirm in the Ksenia app that the right room changes.

## Startup Messages

| Message | Meaning and action |
|---|---|
| `Exposure policy: N device(s) of a category the plugin does not recognize are not exposed ...` | Outputs or scenarios are hidden by the fail-closed policy. The message lists them and ends with the exact `exposeOutputs` / `exposeScenarios` lines. Add only what is safe to operate from voice assistants, scenes and automations, then restart. **"An output or scenario disappeared after updating to 2.3.0"**: this is why |
| `Exposure policy: these opt-in entries have no effect` | An `exposeOutputs` or `exposeScenarios` row names something already recognized, or something the panel does not list |
| `Exposed scenarios the panel flags with a PIN requirement` | Check that running those scenarios without a code is intended |
| `Configuration: N value(s) ignored or adjusted (fix them in the plugin settings)` | A value has the wrong type or is out of range; each line names the key. Fix it in the settings; the safe default applies meanwhile |
| `Invalid configuration, pin: must be a string or a number` | The PIN has a wrong type: the plugin does not start |
| `Configuration: these entries match no device discovered on the panel ...` | A `matterOverrides`, `matterRecoveryRequests` or `customNames` entry names a device the panel does not have. A hint says when the ID is only a number (`1` instead of `zone_1`) or in capitals |
| `[Matter] matterOverrides hides N device(s) from Matter: ...` | Written after the first synchronization; counts only devices the panel really reported. If you did not untick "Exposed on Matter" yourself, tick it again in the plugin settings |
| `HomeKit (HAP) limit reached: a Homebridge bridge holds at most 149 accessories ...` | The devices beyond the limit stay on Matter and MQTT. Use `exclude*` lists or a child bridge |
| `KSA import: keeping your domusThermostat.manualCommandPairs entry for thermostat_N ...` (info) | Your pair differs from the backup; nothing to do unless the panel was reprogrammed |
| `KSA import was applied for this run but could not be saved to config.json` | The import runs again at the next start; check that `config.json` is writable |
| `config.json could not be replaced atomically (EBUSY); rewriting it in place` | Typical with a single-file Docker bind mount; mount the Homebridge directory instead |
| `config.json has N "Lares4Complete" blocks and none can be told apart as this instance` | Keep a single block, or give each a distinct `name` |
| `KSA file is too large (X MB; the limit is 32 MB)` | The `.ksa` file is refused |
| `Skipping cache handler init for X: missing or malformed device context` | A damaged cached accessory is skipped (and realigned at the next discovery); the others are restored |
| `error reporting was removed in 2.3.0; the telemetry key is ignored` | Delete `telemetry` from `config.json` when convenient |

## Connection Messages

| Message | Meaning and action |
|---|---|
| `The panel refused the login N times in a row ... one attempt every 60 min` | Check the PIN and that the user is enabled on the panel. The plugin retries once an hour; restart Homebridge after fixing the PIN to reconnect at once |
| `The panel did not answer the last 5 logins ...` | The panel is restarting, busy or at its limit of open sessions (app, web, other clients). The plugin keeps reconnecting with the normal backoff; the PIN is not in question |
| `The panel refused the <TYPE> read (...)` | A discovery read (`ZONES`, `MULTI_TYPES`) fails the synchronization and the plugin reconnects with backoff; a refused status or thermostat read is logged and the synchronization continues |
| `The panel refused the <TYPE> read (...) in N synchronizations in a row: continuing without it` | The devices of that read are not discovered or updated in this session (existing accessories are kept). Check the permissions of the panel user configured in the plugin |
| `The panel refused the realtime registration (...)` / `The panel did not complete the synchronization within 60s` | The session is closed and retried with backoff |
| `<...> frame with a wrong CRC_16: dropped (N frame(s) dropped in this session so far)` | A corrupted frame. Frequent ones: check the network path |
| `The panel sent a <...> frame with non-ASCII text ... whose CRC_16 differs ...` | Not an error: the frame is accepted. The panel computes the CRC of accented characters in a way the plugin has not verified yet; please open an issue with this line |
| `Zone status field X reported "Y", a value not observed before` | Informational: a new value of a zone field, logged once |

## Command Messages

| Message | Meaning |
|---|---|
| `Command for gate_N not sent: a previous command for it is still in progress` | Pressing again while a pulse waits for the panel is refused (gates, scenarios) |
| `... replaced by a newer command` | Lights, dimmers, covers: only the latest queued command is sent |
| `... still queued after N ms` | The command waited longer than `commandTimeoutMs` and was refused instead of being sent late |
| `Command refused: X is not a light discovered on the panel` | The device is not (or not yet) a discovered device of that kind: hidden by the exposure policy, or the first synchronization has not finished |
| `cfg id X (from ...) could not be read from the panel; write refused` | A thermostat write was refused because its routing could not be established. Fix `domusThermostat.manualCommandPairs` |
| `... is not the heating or cooling output of any PRG_THERMOSTATS program` | The thermostat output belongs to no program on a panel that has programs |
| `... does not match what this thermostat reports in realtime` | A guessed routing was rejected as incoherent; add the `manualCommandPairs` line the error shows |
| `Thermostat realtime mode ACT_MODEL=... is not known to the plugin` | Report the value in an issue; the thermostat is shown as heating or cooling meanwhile |

## Common Symptoms

### Thermostat changes the wrong room

A routing mismatch between the output and the panel thermostat ID. Enable `ksaImport` with a valid `.ksa`, or set `manualCommandPairs`. With debug logging look for `thermostat_<output> => cfg:<id> domus:<id> source:<...>`. The plugin refuses writes it cannot route (see above), so this should now fail with an error rather than change another room.

### Startup states do not sync

Verify that `STATUS_TEMPERATURES` is in the realtime registration and changes, that the `CFG_THERMOSTATS` read succeeded, and that there are no repeated reconnect or login loops.

### `PRG_THERMOSTATS` unavailable

Some firmware answers "command unavailable" at every login; this is expected and not reported. Rely on the KSA sanitized cache (check that `klares4-ksa-cache.json` exists in the Homebridge storage folder) or `manualCommandPairs`.

### Self-signed certificate or `unsafe legacy renegotiation disabled`

Lares4 panels use a self-signed certificate and many need legacy TLS renegotiation, which current Node.js versions refuse by default. The log shows a hint naming `allowInsecureTls`. On a trusted local network, enable `allowInsecureTls` and restart Homebridge; otherwise, if the panel allows it, set `https: false` for plain `ws://`.

### A device is missing or a sensor shows "No Response"

A hidden device (unrecognized category: see the first row of the startup messages), an excluded one, or a sensor the panel has not reported yet (an offline DOMUS, for example) shows nothing or "No Response" instead of a made-up 0 °C or "no motion".

### MQTT consumers lost a device

Check for a name collision (the device moved to `.../<type>/<device id>/state`), for an exclusion or hidden device, and for `mqtt.commands: false` (only commands are off, state still flows). See [MQTT](./mqtt.md).

## Debug File

Turn on `generateDebugFile`, restart, reproduce the problem from the Ksenia app or from HomeKit while the capture runs, wait for the end-of-capture message in the log, and fetch `klares4-debug-<timestamp>.json` from the Homebridge storage folder. **The file is confidential**: send it privately, never in a public issue. See [Privacy and the Debug File](./privacy-and-debug-file.md).

## Safety Notes

- Never commit raw `.ksa` backups or debug files.
- The plugin cache is sanitized by whitelist extraction.
- Keep `allowInsecureTls` off unless the log asks for it and the network is trusted.
- Contributors: `npm run test:contract` runs the Matter contract tests and `npm run test:coverage` the suite with coverage thresholds; see the README, section Development.
