# Privacy and the Debug File

## What the Plugin Sends, and Where

- **No telemetry.** The plugin sends nothing to any third party. Anonymous error reporting (Sentry) existed up to 2.2.x and was removed in 2.3.0 together with its dependency, and a test fails if a telemetry or analytics dependency ever comes back.
- The only network connections the plugin opens are the WebSocket to **your panel** and, if you enable the MQTT bridge, the connection to **your broker**.
- A `telemetry` key left in `config.json` is ignored; the plugin logs one line saying so.

## What Is Stored, and How Private It Is

- **The PIN is stored in clear text in `config.json`**, which is Homebridge's own file. Use a dedicated panel user with only the rights this plugin needs, and protect the Homebridge storage folder.
- The PIN is never written to the log, to MQTT or to the debug file. In the log, the value of every credential-like key (`PIN`, `PIN_CODE`, `USER_PIN`, `PASSWORD`, `CODE`, `TOKEN`, ...) is masked, whatever its type or where it sits (a PIN with quotes, a number, a truncated frame, a JSON text carried as a string). The `LOGIN` frame is logged only at debug level, masked. The MQTT broker is logged as `scheme://host:port` only.
- Files the plugin creates for the first time (debug file, KSA cache, Matter stores, device list, room-mapping example) are private (`0600`); existing files keep their permissions. Leftover temporary files from a crash (for `config.json` they contained the PIN) are removed at startup once older than five minutes.
- The KSA cache holds sanitized data only; the raw `.ksa` backup is not stored.

## The Debug File

`generateDebugFile: true` records the raw WebSocket traffic at the next start, for `debugCaptureDurationMs` (default 60 seconds, 10 s to 30 min), and writes `klares4-debug-<timestamp>.json` in the Homebridge storage folder. The flag switches itself off in `config.json` (if the file cannot be rewritten the plugin says so and tries again at the next start). If Homebridge stops before the capture ends, the file is written at shutdown with what was recorded.

**The debug file is confidential.** It contains the names of your devices and the state of your alarm system. PINs, account data, panel serial numbers and the home position are masked. Do not attach it to a public issue; send it privately, and only to someone you trust. Delete it when you no longer need it.

### What is masked

Masked by key, at any depth, in frames in both directions, in device snapshots and in the sections derived from them, whatever the value type (a frame that cannot be parsed is masked as text); the masked value is written `***MASKED***`:

- credentials: any key with a segment `pin`, `pwd`, `passwd`, `password`, `passcode`, `secret`, `token`, and the key `code`;
- position: `POSITION`, `LAT`, `LONG`, `LON`, `LNG`, `LATITUDE`, `LONGITUDE`, and the sunrise and sunset times (`DAWN`, `DUSK`), which together with the date reveal latitude and longitude;
- identity: the account description and ID (`DESCRIPTION`, `ID_ACCOUNT`), serial numbers (`SN`, `SERIAL`) and the panel identifier that frames from the panel carry in `SENDER`.

**Not masked, on purpose:** the names of zones, outputs, scenarios and bus devices, the state fields, `ID_LOGIN`, `CRC_16`, `TIMESTAMP` and firmware strings: they are needed to diagnose a problem.

### Limits

The capture keeps at most 20,000 frames and 8 MiB of traffic in memory. Later frames are counted (`captureInfo.droppedMessages` in the file), one warning is logged (`[DEBUG] Capture buffer full ...`) and the capture still ends on time.

### Log lines

- At the start: `[PRIVACY] The file will be confidential: it lists your devices and the state of your alarm system.`
- When the file is written: four `[PRIVACY]` lines (confidential; what is masked; do not attach it to a public issue; mode `0600`) and the path of the file.

### Files written by earlier versions

Debug files written by 2.2.x and before are `0644` and contain the home position and the account description. Delete them, or restrict them (`chmod 600`), before sharing or copying them anywhere. If you shared one, you shared the coordinates of the installation.

## Reporting a Security Problem

See [`SECURITY.md`](../../SECURITY.md): use GitHub's private vulnerability reporting or the email address there, never a public issue.
