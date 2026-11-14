# C — Connection, sync, parsing, zones

Findings: WS-05, WS-07, WS-10, WS-12, WS-13, WS-14 (except the response-ID item, task B), PLAT-13, TD-T-09 (M43, M44, M45).

## Config keys

None added, changed or removed in `config.schema.json`. Three **internal** client options were added to `KseniaWebSocketOptions` (not read from the user config, not for the schema; the platform keeps the defaults):

| Option | Type | Default | Purpose |
|---|---|---|---|
| `maxPayloadBytes` | integer | 4194304 (4 MiB) | Largest inbound WebSocket frame |
| `suspendedLoginRetryMs` | integer | 3600000 (1 h) | Delay between logins once 3 logins in a row failed |
| `syncTimeoutMs` | integer | 60000 | Budget from an accepted login to the accepted realtime registration |

## Changelog entries (2.3.0)

### Security
- A login the panel keeps refusing is no longer retried at the normal pace in more cases: a refusal whose ID does not match the login, the panel closing the connection during the login, a login left unanswered, or an accepted login without a session ID now count like an explicit refusal. After 3 failed logins in a row the plugin slows down to one attempt per hour instead of retrying every few seconds. (WS-10)
- Frames from the panel are checked before use: a frame whose CRC does not match, that is not a JSON object, has no `CMD` or a `PAYLOAD` that is not an object is dropped and logged. Frames larger than 4 MiB close the connection, which is then re-established (real frames are a few tens of kB). (WS-14)

### Changed
- After 3 failed logins in a row the plugin no longer stops for good until Homebridge is restarted: it tries again once per hour, and logs at every failed attempt what to check (PIN, user enabled on the panel). Restarting Homebridge after fixing the PIN reconnects at once. (WS-10)
- `RESULT` in panel answers is read the same way everywhere (case and spaces ignored): a login answered with `ok` is accepted. (WS-10)
- The reconnection delay restarts from `reconnectInterval` only after a complete synchronization, not after a bare login: a panel that accepts the login but refuses the data reads is retried with a growing delay. (WS-05)

### Fixed
- The initial synchronization is no longer reported as complete when the panel refuses the realtime registration or the zones/outputs discovery read: the refusal is logged as a warning and the plugin reconnects with backoff. Previously the plugin stayed connected without ever receiving a status change. A refused status or thermostat read is logged and the synchronization continues (the realtime registration carries the initial status again); the `PRG_THERMOSTATS` answer `CMD_NOT_AVAILABLE` that panels give at every login is not reported. A panel that never answers the realtime registration is reconnected after 60 s. (WS-05)
- A sensor value the panel reports as missing or unreadable (`NA`, empty, not a number) no longer turns the discovery placeholder (0 °C, 100 lux) into a real reading on HomeKit, Matter and MQTT; the device stays "not yet observed" until a valid reading arrives. (WS-07)
- Out-of-range or unreadable values are discarded instead of being moved to the nearest limit: a probe reporting 999 °C, a humidity of 150 %, an outdoor temperature of −70 °C, a cover position of `abc` or 300 no longer become 100 °C, 100 %, −50 °C, "closed" or "open". A cover update without a readable position (for example `STOP` without `POS`) keeps the last position instead of jumping to 50 %. Lights accept `ON`/`OFF` in any case; any other value leaves the light unchanged. A zone update carrying only some fields changes only those fields instead of resetting the others to "closed, not bypassed". Sensor values sent as JSON numbers are accepted. (WS-13)
- A device deleted or re-categorised on the panel (for example an output changed from light to shutter) leaves the plugin's live state after the next complete discovery read, so its old twin no longer receives the new device's status. (WS-12)
- Zone tamper: the panel's `T` field is now read and shown as HomeKit `StatusTampered` (it was always 0). (PLAT-13)
- When the panel stops answering pings (half-open connection), "disconnected" is reported at once and pending commands fail immediately, also with a short `reconnectInterval`. (WS-14)
- `connect()` always completes: a shutdown during the login or while connecting no longer leaves it pending, and a shutdown while connecting is no longer logged as an error. (WS-14)
- An IPv6 address in `ip` now works (it is put in brackets in the panel URL). (WS-14)
- Statuses received for devices that were never discovered are kept for at most 512 IDs. (WS-14)

## Migration notes
- No persisted data, UUIDs, MQTT topics or config keys change.
- Users whose panel refuses the login (wrong PIN) used to need a Homebridge restart after 3 failures; now the plugin retries once per hour on its own. Fix the PIN and restart Homebridge to reconnect immediately.
- MQTT zone payload is unchanged (`open`, `armed`, `fault`, `bypassed`); the tamper flag is shown on HomeKit only (adding it to the MQTT payload would be an additive change of the golden payload, not done in 2.3.0).

## Integration done at the end of wave 1
- Task A: `exposeOutputs` / `exposeScenarios` reach the discovery through the client; `isScenarioSuppressed` honours the scenario opt-in; new facade method `KseniaWebSocketClient.isHiddenByExposurePolicy(deviceId)`, used by `clientExposurePolicy` so cached accessories of hidden **outputs** are treated as excluded like hidden scenarios.
- Task D: `NOT_MASK_UNSOLICITED / NM_CHANGES` reaches the thermostat cfg cache; `PRG_CHECK` of `CFG_THERMOSTATS` is the change-counter baseline; the command service publishes the thermostat state on ACK; the legacy `MODE` of `STATUS_OUTPUTS` uses `parseKseniaMode` (an unknown mode no longer reads as off); `state.ts` initialises `hiddenByExposurePolicy` and `thermostatCfgFreshness`.
- Task B: `command-dispatcher.ts` reads RESULT through `websocket/protocol-result.ts`; a RESULT that is not a string is now a refusal there too (it used to be "no RESULT").
- Every fake panel in the tests signs its frames (`test/fixtures/panel-frame.js`).

## Documentation notes (task L)
- Troubleshooting: the new log lines — "The panel refused the <TYPE> read (...)", "The panel refused the realtime registration (...)", "The panel did not complete the synchronization within 60s", "<...> frame with a wrong CRC_16: dropped (N frame(s) dropped in this session so far)", "The panel refused or did not answer the login N times in a row ... one attempt every 60 min", "Zone status field X reported "Y", a value not observed before".
- `docs/*/websocket-protocol.md`: CRC is verified on inbound frames; RESULT normalization; which refused reads fail the sync (ZONES, MULTI_TYPES, REALTIME) and which do not (status reads, CFG/PRG thermostat reads); the login guard (what counts, 3 in a row, 1 h slow retry, reset on a successful login); `maxPayload` 4 MiB; the sync watchdog (60 s); devices no longer listed are dropped from the client state after a complete discovery section.
- Zone field mapping (README / zones doc), with the caveat below.
- ARCHITECTURE: `connection-service.ts` is now split into `connection-setup.ts` (URL, TLS agent, maxPayload), `heartbeat-monitor.ts`, `reconnect-scheduler.ts`; `message-service.ts` uses `inbound-frame.ts` (parse + shape + CRC), `login-response-handler.ts`, `sync-read-policy.ts`; `websocket/protocol-result.ts` is the single RESULT normalization; `discovered-device.ts` has the discovery rounds.

## To verify on the real panel (rc)
- **Login refusal shape**: no refused login was ever captured. Expected and handled: `LOGIN_RES` with RESULT other than OK (with or without our ID), socket closed by the panel, no answer. Capture one refused login (wrong PIN on a test user) with debug capture and check that it is counted once and that the log names the cause.
- **Zone fields**: real captures only show resting values (`BYP` NO, `A` N, `T` N, `FM` F). Mapping chosen: `BYP` ≠ `NO` → bypassed; `T` ≠ `N` → tampered; `A` `Y` → armed (meaning of `A` unknown: never `Y` even for a zone in alarm); `FM` T/F; `STA` A/R. Capture one excluded (bypassed) zone and one tamper/alarm to confirm; any new value is logged once at info.
- **CRC**: 449 of 449 inbound frames in the 7 readable real captures match the plugin's algorithm (one capture file is truncated and could not be read); all frames were ASCII. A device name with accented letters would be the first non-ASCII frame: if such frames are dropped with "wrong CRC_16", report it.
- **Refused reads on panels without thermostats**: `CFG_THERMOSTATS`/`PRG_THERMOSTATS` refusals do not fail the sync by design.
