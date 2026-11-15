# WebSocket Protocol

## Transport and Session

- Connection target:
  - HTTPS WSS: `wss://<ip>:443/KseniaWsock/`
  - HTTP WS: `ws://<ip>:80/KseniaWsock/`
  - An IPv6 address is put in brackets in the URL.
- WebSocket subprotocol: `KS_WSOCK`.
- TLS: the panel uses a self-signed certificate and old TLS settings. With `allowInsecureTls: true` (and `https`) the plugin skips certificate verification and allows the legacy renegotiation flags; without it the connection is strict. Both failures are recognized in the log with a hint naming `allowInsecureTls`.
- Frames larger than 4 MiB (real frames are a few tens of kB) close the connection, which is then re-established.
- Heartbeat: a native WebSocket ping every `heartbeatInterval`. No pong for two intervals means a half-open connection: the plugin reports "disconnected" at once, pending commands fail immediately and the session reconnects.

## Envelope and CRC

Every frame, in both directions, is a JSON object:

| Field | Meaning |
|---|---|
| `SENDER`, `RECEIVER` | Sender label (the `sender` option); the panel answers with its own identifier |
| `CMD` | Command family: `LOGIN`, `READ`, `REALTIME`, `CMD_USR`, `WRITE_CFG` and their `*_RES` answers, `NOT_MASK_UNSOLICITED` |
| `ID` | Request identifier, echoed by the answer (some firmwares echo it as a JSON number) |
| `PAYLOAD_TYPE` | What the command is about (`ZONES`, `MULTI_TYPES`, `CFG_THERMOSTATS`, `CMD_SET_OUTPUT`, ...) |
| `PAYLOAD` | An object. `ID_LOGIN` (the session) and `PIN` are filled in by the plugin |
| `TIMESTAMP` | Unix seconds, as text |
| `CRC_16` | CRC-16 of the frame (polynomial 0x1021, seed 0xFFFF, as in `websocket-client/crc16.ts`) over the UTF-8 bytes up to and including the `"CRC_16"` key, written as `0x` and four hex digits. The plugin's algorithm matched every inbound frame of the real captures it was checked against |

**Inbound frames are checked before anything reads them.** A frame is dropped and logged (never quoted, since it may carry names of the site) when it is not valid JSON, is not an object, has no `CMD`, has a `PAYLOAD` that is not an object, or carries a `CRC_16` that does not match. A frame with no `CRC_16` is accepted. The log counts the dropped frames of the session.

`RESULT` in answers is read the same way everywhere (case and spaces ignored, so `ok` is accepted); a `RESULT` that is not text is a refusal.

## Login and the Login Guard

- Login command: `CMD=LOGIN`, `PAYLOAD_TYPE=UNKNOWN`, with `PIN`. On an accepted `LOGIN_RES` the plugin stores `ID_LOGIN` and starts the synchronization. The `LOGIN` frame is logged only at debug level, masked, and never at every reconnection at normal level.
- **What counts as a failed login:** an explicit refusal (with or without the ID of the request), an answer without a session ID, no answer before the login timeout, or the panel closing the socket before the answer. Failures before the frame is sent do not count.
- **After 3 failed logins in a row** the plugin does not stop for good: it slows down to **one attempt per hour**, logs at every failed attempt what to check (the PIN, and that the user is enabled on the panel), and resets on the first accepted login. Restarting Homebridge reconnects at once. The slowdown protects against panels that lock a user out after wrong codes.

## Synchronization

Each login is one synchronization. The plugin sends, in order:

1. `READ/ZONES`
2. `READ/MULTI_TYPES` (`OUTPUTS`, `BUS_HAS`, `SCENARIOS`)
3. `READ/STATUS_OUTPUTS`
4. `READ/STATUS_BUS_HA_SENSORS`
5. `READ/STATUS_SYSTEM`
6. `READ/PRG_THERMOSTATS`
7. `READ/CFG_THERMOSTATS`
8. `REALTIME/REGISTER` for `STATUS_ZONES`, `STATUS_OUTPUTS`, `STATUS_BUS_HA_SENSORS`, `STATUS_SYSTEM`, `STATUS_TEMPERATURES` and `SCENARIOS`

The synchronization is **complete only when the panel accepted the realtime registration**.

- A refused `ZONES` or `MULTI_TYPES` read, or a refused realtime registration, fails the synchronization: the refusal is logged as a warning, the session is closed and the plugin reconnects with backoff.
- A refused status read or thermostat read is logged and the synchronization continues: the realtime registration carries the initial status again. The `CMD_NOT_AVAILABLE` answer to `PRG_THERMOSTATS` that panels give at every login is expected and not reported.
- A panel that never answers the realtime registration is reconnected after 60 seconds.
- A device that a complete discovery section no longer lists is dropped from the client's live state (so a deleted or re-categorised device cannot keep receiving the status of its successor). The platform removes accessories only after three complete synchronizations.
- Statuses received for devices that were never discovered are kept for at most 512 IDs.

## Reconnection

Exponential backoff from `reconnectInterval`, with a ceiling of 60 seconds and about 10 % jitter, one timer at a time. The backoff restarts only after a **complete synchronization**, not after a bare login: a panel that accepts the login but refuses the data reads is retried with a growing delay. After the login guard has slowed reconnection, the delay is one hour.

## Routing

- Responses (`*_RES`) go through the protocol router; `READ_RES` payloads update discovery state and caches.
- `REALTIME_RES/REGISTER_ACK` and realtime changes both update the runtime state.
- `NOT_MASK_UNSOLICITED` with `NM_CHANGES` tells the plugin that the configuration of a thermostat changed on the panel; the cached configuration is dropped and re-read before it is used again.
- One malformed entry in a frame, or an error while handling one device, is logged with the frame type, the device ID and a stack trace and does not drop the other devices of the frame.

## Commands

| Command | Used for |
|---|---|
| `CMD_USR` / `CMD_SET_OUTPUT` | Lights, dimmers, covers, gates |
| `CMD_USR` / `CMD_EXE_SCENARIO` | Scenarios |
| `WRITE_CFG` / `CFG_ALL` with `CFG_THERMOSTATS` | Thermostats (answer `WRITE_CFG_RES`) |

The legacy thermostat fallback `WRITE/THERMOSTAT` is not used. Commands only reach outputs and scenarios the plugin discovered with that kind: a command for anything else (a stale cached accessory of a hidden output, an MQTT topic) is refused and nothing is sent. Before the first synchronization has listed the devices, commands from cached accessories are refused too.

### Lifecycle of a command

`requested` → `queued` → `sent` → `acknowledged` (the answer carries `RESULT=OK`) or `state-confirmed` (the output really changed) → or `rejected` / `timed out`. A socket write alone is never a success.

- **Queue.** Commands are queued per device. The deadline is `commandTimeoutMs`: a command still queued after it is refused, never sent late. At most 4 commands wait behind the running one for a device.
- **Per-device policies.** Lights, dimmers and covers: `latest-wins` (only the newest waiting command is kept, the others are refused). Gates and scenarios: `reject-while-busy` (pressing again while a pulse waits for the panel is refused). Thermostat writes: serial, one running and one waiting per panel thermostat (commands for the same thermostat are merged before queueing).
- **Correlation.** The answer is matched by `ID`; numeric IDs are matched too. Only when the panel gives no usable ID and exactly one pending command is compatible is that one used (`single-compatible`). A response ID that was already settled is not reused.
- **Acknowledgement.** For every command that changes something on the panel (`CMD_USR`, `WRITE_CFG`) only an explicit `RESULT=OK` acknowledges it; an answer without it is a failure, and a command sent without any confirmation is an error, never a success.
- **State confirmation.** Output writes (lights, dimmers, covers) are confirmed by the realtime state only as a **transition observed after the command was registered**: the output must actually change to the requested state. A state the output already had, or the late event of an earlier command on the same output (for up to one command timeout), does not count; numbers are compared strictly; a refusal from the panel always wins.
- **Validation.** `NaN`, `Infinity`, a non-number brightness or position and an on/off that is not a boolean are refused before anything is sent.
- When the connection drops, every pending and queued command is refused.

## Thermostat-Relevant Payloads

### `CFG_THERMOSTATS`

Persistent thermostat configuration. It is read at login, re-read before a setpoint write, and used for the partial write forms described in [Domus Thermostats and KSA](./domus-thermostats.md). Its `PRG_CHECK` counter is the baseline for change detection.

### `STATUS_TEMPERATURES`

Realtime thermostat status: current temperature, target (when a valid number), HVAC mode, season (`ACT_SEA`) and output state. **Its `ID` is the DOMUS sensor ID**, not the thermostat configuration ID.

### `STATUS_OUTPUTS`

Output runtime status; for thermostats it is secondary (activity correlation), not a routing authority. For lights and covers it is the realtime source of the state confirmation.

### `PRG_THERMOSTATS`

Structural map, if the firmware exposes it: thermostat program ID, linked DOMUS sensor (`PERIPH.PID`) and the heating and cooling outputs (their role). Used to resolve command routing without guessing.

### Zone fields

`BYP` other than `NO` means bypassed; `T` other than `N` means tamper (HomeKit `StatusTampered`); `STA` is open/closed; a field that is missing from an update leaves that field of the zone unchanged. A value the plugin has not seen before is logged once.

### Sensor values

A value the panel reports as missing or unreadable (`NA`, empty, not a number), or outside the plausible range (999 °C, 150 % humidity, a cover position of `abc`), is discarded: the device stays "not yet observed" (HomeKit "No Response") until a valid reading arrives.
