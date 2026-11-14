# I — No telemetry; debug capture

Finding: SP-01, SP-02, SP-03, SP-08, SP-12, SP-13, SP-17, SP-18, SP-19 / G-07, SP-21, and the telemetry/capture items of SP-23.

## Config keys

No key added.

**Removed from the schema: `telemetry`.** The plugin ignores the key if it is still in `config.json` (it logs one `info` line at startup, see below) and never reads it.

| What to change in `config.schema.json` | Where |
|---|---|
| Delete the property `telemetry` ("Telemetria / Segnalazione Errori", boolean, default `true`, mentions Sentry) | `schema.properties`, line ~656 of the 2.2.0 file |
| Delete the layout entry `{ "key": "telemetry", "title": "Abilita Telemetria", ... }` | `layout`, advanced/debug section, line ~1316 |
| `generateDebugFile` description (IT, and EN if one is added): say the file is confidential. Suggested IT: "Attiva per generare un file di diagnostica al prossimo riavvio (si disabilita automaticamente dopo la generazione). Il file e riservato: contiene i nomi dei dispositivi e lo stato dell'impianto, non va allegato a segnalazioni pubbliche." | `schema.properties.generateDebugFile.description` |
| The help block "Strumento diagnostico completo" ("Genera un file di supporto con: ...") needs a last paragraph with the same warning: "Il file contiene i nomi dei dispositivi e lo stato dell'impianto (PIN, account, seriali e posizione sono mascherati): non allegarlo a segnalazioni pubbliche, invialo in privato." | `layout`, the `help` item above `generateDebugFile` |

Nothing else in the schema changes. `debugCaptureDurationMs` keeps its 10000..1800000 limits (the plugin no longer clamps them a second time, the runtime config is the only place).

No config key for the capture buffer limits: they are fixed (20,000 frames and 8 MiB of stored frames), far above the traffic of the longest allowed capture (about 4 MB in 15 minutes on a real installation).

## Changelog entries (2.3.0)

### Security
- The plugin no longer sends anything to a third party. Anonymous error reporting (Sentry) is removed completely: the module, the embedded DSN, the `@sentry/node` dependency and the settings entry are gone, and the plugin opens no connection other than the one to your panel (and to your MQTT broker, if you enable it). This also removes what the reporting client did inside the shared Homebridge process: global hooks on the module loader that rewrote the code of about 80 other packages, scopes shared with other plugins, and the loading cost (about 250 ms and 35 MB at startup, paid even with `telemetry: false`). (SP-02, SP-03, SP-08, SP-12, SP-13, SP-17, SP-19, SP-21)
- The debug file (`generateDebugFile`) is now treated as confidential. It is written readable by its owner only (`0600`), the log and the file say so and no longer invite you to share it, and the home position, the account (ID and description), the serial numbers of the bus devices and the panel identifier are masked together with the PIN. The previous version masked only the PIN of outgoing frames: the login answer of the panel carried the GPS coordinates of the house, which ended up in the file. Masking applies at any depth, to frames in both directions, to device snapshots and to the sections derived from them; a frame that cannot be parsed is masked as text instead of being stored as it came. (SP-01, SP-18)

### Changed
- Debug file: names of devices and the state of the installation are still in the file (they are needed to diagnose a problem), so it must not be attached to a public issue: send it privately. The file names the masked values `***MASKED***`. (SP-01)
- Debug capture keeps at most 20,000 frames and 8 MiB of traffic in memory; later frames are counted (`captureInfo.droppedMessages`), one warning is logged, and the capture still ends on time. (SP-23)
- `telemetry` is no longer a setting: if it is in `config.json` the plugin logs one line ("error reporting was removed in 2.3.0; the `telemetry` key is ignored and can be deleted") and ignores it. (SP-08)
- The install size drops: `@sentry/node` and its dependencies (23 packages, about 95 MB of `node_modules` and 5,600 files: 104 MB before, 11 MB after) are no longer installed.

## Migration notes
- Nothing to do. `telemetry` in `config.json` is harmless; delete it when convenient. Debug files written by earlier versions are `0644` and contain the home position and the account description: delete them, or restrict them (`chmod 600`), before sharing or copying them anywhere.
- Anyone who shared a debug file from 2.2.0 or earlier has shared the GPS coordinates of the installation, the account description and the state of the alarm system (the PIN was masked in those files, except in the 1.1.x files, where it was in clear in the parsed copy of the frame: see SP-22 in `reports/secpriv.md`).

## Documentation notes (task L)
Remove or rewrite:
- `README.md` EN: config table row for `telemetry` (line ~226) and the whole `#### Telemetry` section (~382-396, with the `"telemetry": false` example and the anchor `#telemetry` linked from the table). README IT: same, row at ~634 and section ~790-804 (anchor `#telemetry-1`).
- `README.md` EN ~380 and IT ~788 (the paragraph on `generateDebugFile`): the IT text says the file is "da allegare a una segnalazione", and the table rows (~227, ~635) say "PINs masked". Replace with: the file is confidential, written `0600`, holds device names and alarm state, PIN/account/serials/position are masked, it must be sent privately, never attached to a public issue.
- `docs/en/config-and-ui.md` and `docs/it/configurazione-e-ui.md`: the whole `## Telemetry` section (lines ~94-104 in both).
- `docs/en/operations-debug.md` line ~54 and `docs/it/operazioni-debug.md` line ~54: "with PINs masked" must become the confidentiality note above; add that the file is `0600`, that the buffer is capped, and that `captureInfo.droppedMessages` tells whether frames were left out.
- `SECURITY.md`: there is no telemetry entry to remove, but the file says nothing about privacy. Add a short "Privacy" section: the plugin makes no connection to third parties; the only outbound connections are the panel (WebSocket) and the optional MQTT broker; the debug file is confidential. (Also noted in SP-20: the supported-versions table still says 1.1.x.)
- `ARCHITECTURE.md`: no mention of telemetry exists. Add under the debug capture description: `debug-capture/redaction.ts` (key-based redaction, text fallback), `debug-capture/capture-buffer.ts` (caps), and that the file is written with mode `0600`. Remove `telemetry.ts` from any module list a later task adds.
- `CHANGELOG.md`: the 2.2.0 entries that describe Sentry (lines ~26, 35, 36, 45, 47, 196-225, 248, 307) are history; leave them. Do not describe the removal there.
- Verified Plugins: with no telemetry the "No analytics or tracking" requirement is met (SP-20); worth one line in the release notes.

The debug-file privacy statement (to reuse): *"The debug file is confidential. It contains the names of your devices and the state of your alarm system. PINs, account data, panel serial numbers and the home position are masked. Do not attach it to a public issue; send it privately."*

## New log lines (for the troubleshooting page)
- `info`: `error reporting was removed in 2.3.0; the `telemetry` key is ignored and can be deleted` (once, only if the key is in the config, whatever its value).
- `warn` while a capture starts: `[PRIVACY] The file will be confidential: it lists your devices and the state of your alarm system.`
- `warn` when the file is written: four `[PRIVACY]` lines (confidential; what is masked; do not attach to a public issue; mode `0600`). The line `[SHARE] Share this file for support - PINs are already masked!` no longer exists.
- `warn` once if the buffer is full: `[DEBUG] Capture buffer full: later traffic is counted but not recorded; the capture still ends on time.`

## Key list used for the redaction (derived from real captures: names only were read)
Masked by key, at any depth, whatever the value type (string, number, array, object):
- credentials: any key with a segment `pin`, `pwd`, `passwd`, `password`, `passcode`, `secret`, `token`, and the key `code` (case-insensitive: `PIN`, `USER_PIN`, `4DIGIT_PIN`, `pin`). Exception: `PIN` inside `SCENARIOS[]` when it is one to three capital letters (the real flag `N`/`P`/`PR`).
- position: `POSITION`, `LAT`, `LONG`, `LON`, `LNG`, `LATITUDE`, `LONGITUDE`, plus `DAWN` and `DUSK` of `STATUS_SYSTEM[].TIME` (sunrise and sunset times, with the date, give latitude and longitude; the plugin does not use them).
- identity: `DESCRIPTION` (upper case, the account description of `LOGIN_RES`; the device snapshot's own `description` stays), `ID_ACCOUNT`, `SN` (also `LINK.SN`), `SERIAL`, and the top-level `SENDER` of incoming frames (a 12-character hexadecimal identifier of the panel; the plugin's own `SENDER` in outgoing frames, and `RECEIVER`, stay).
- kept on purpose: `DES` of zones, outputs, scenarios and bus devices (names), `ID_LOGIN`, `CRC_16`, `TIMESTAMP`, `VER_LITE`, firmware/hardware strings, every state field.

## Requests for other tasks
- Task C (owner of `src/websocket-client/tls-error-hint.ts`): the header comment says "the platform also keeps them out of telemetry"; there is no telemetry any more. Reword to drop that clause. This is the last mention of the word in `src/`.
- Task L: the points above.
- Task K: `package.json` loses one dependency and `package-lock.json` 627 lines; whoever merges K and I should regenerate the lock with `npm install` if the files conflict, not edit by hand. A Dependabot group or ignore rule for `@sentry/*` (if any exists in `.github/dependabot.yml`) can go; none was found. The new regression test `test/no-outbound-network.test.js` is the guard against a future telemetry dependency; it also scans `src/` and `dist/` for `sentry`/`opentelemetry` and fails if the package declares such a dependency.
- Task T0.3 / G (`resolveRuntimeConfig` is called a second time in `initializeLares4`, after the KSA import): every configuration warning is therefore logged twice at startup when the config has problems. Not part of this task; the new deprecation line is emitted from `reportDeprecatedKeys`, called once in the constructor, so it appears once.
