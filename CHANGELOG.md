# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Release 2.3.0 closes the findings of a full review of 2.2.0: security and privacy, fail-closed exposure, command and connection reliability, thermostats, Matter lifecycle, MQTT, configuration validation, documentation and release pipeline. **Read "Upgrading from 2.2.x" first: some devices disappear until you opt them back in, and thermostats become new accessories in your Matter controllers.**

### Upgrading from 2.2.x: read first

**Things you will notice at the first start**

- **Outputs and scenarios of an unrecognized category are hidden.** In 2.2.0 every output that was not a light, cover, gate or thermostat appeared as a light, and every scenario that was not arming appeared as a switch. Sirens (`GEN`, mode `AT`), alarm bridges (`GEN`, `A`), indicators (`GEN`, `S`), generic relays and door strikes (`GEN`, `M`, `B`), irrigation (`IRR`), outputs without a category, and scenarios with no category or an unknown one (for example `ARM_AWAY`) are now neither exposed nor commandable. The log shows one warning starting with `Exposure policy:` that names each hidden device and ends with the lines to copy. To bring one back, add it to **Device Selection → Expose Hidden Devices** in the plugin settings, or to the platform block of `config.json`, and restart:

  ```json
  "exposeOutputs": [{ "outputId": "12", "exposeAs": "light" }],
  "exposeScenarios": [{ "scenarioId": "4" }]
  ```

  An opted-in output returns as a **light** with the same ID, HomeKit identity and MQTT topic as in 2.2.0. Opt in only what is safe to switch from voice assistants, scenes and automations ("turn off all the lights" included). Accessories of hidden devices left in the HomeKit or Matter cache are removed (HomeKit at the first sync, Matter after three syncs); retained MQTT topics they published are not cleared, delete them on the broker if needed. Arming and disarming scenarios stay never exposed; partial arming still needs `exposePartialArmScenarios`.
- **Thermostats become native Matter Thermostats (Homebridge 2.5).** On Homebridge 2.5 every thermostat had fallen back to a temperature sensor. At the first start of 2.3.0 each one gets one automatic attempt to register as a real Thermostat. Apple Home, Alexa and Google then show a **new accessory** and the sensor disappears: set rooms and automations again. This is deliberate (a controller must not keep scenes that set a temperature on a read-only sensor). Watch the log for `was saved as a TemperatureSensor fallback by an earlier version; trying the native Thermostat once`. A thermostat that Homebridge still refuses comes back as the sensor it was, with its rooms and automations. At a first start without a `.ksa` cache, thermostats appear on Matter up to 20 seconds later: they wait for the panel's program data, which says whether an output heats or cools. Where thermostats were already native, their Matter shape changes (heating-only outputs lose cooling, Auto and Occupancy) and controllers may show them as changed.
- **A heating output and a cooling output of the same Ksenia program appear on Matter as two thermostats**, heating-only and cooling-only. Each shows Off outside its season and refuses commands there. HomeKit is unchanged.
- **Sensors and cover positions show "No Response" for a few seconds after the upgrade.** The cache written by 2.2.0 does not say which values the panel really reported, so the cached value of every sensor and every cover position is treated as a placeholder until the panel reports it (normally within seconds of the first synchronization; on Matter the measurement is unknown meanwhile). Lights, zones, gates, scenarios and thermostats keep their cached state. A sensor that is really offline stays "No Response" instead of showing 0 °C.
- **Settings form in English.** All titles and descriptions are now in English. `telemetry` and `ksaImport.applyExclusionSuggestions` no longer appear; existing values are ignored.

**Behavior and default changes**

- **No telemetry.** The anonymous error reporting (Sentry) is removed; the plugin sends nothing to any third party. A `telemetry` key left in `config.json` is ignored with one log line. Debug files written by earlier versions are world-readable and contain the home position and the account description: delete them, or `chmod 600` them, before sharing or copying them.
- **Device IDs are unchanged.** Every output that 2.2.0 exposed and 2.3.0 still exposes keeps its ID, and with it its HomeKit identity, Matter endpoint and MQTT topic; scenario, zone and sensor IDs are unchanged too. An output reconfigured on the panel to another category (a light that becomes a cover) gets the ID of its new type, as a newly installed output would: a new accessory appears, the old one stops working at once and is removed by the rule below, and its rooms and automations do not carry over.
- **Accessories of devices deleted on the panel are removed without restarting Homebridge**, after three complete synchronizations (a reconnection counts). On HomeKit the removal also needs at least half of the known accessories to be listed. The last device of a kind (the only scenario, for example) is never removed automatically: use the matching `exclude*` list. The panel's own temperature probes are never removed.
- **Commands are refused instead of arriving late.** A command still queued after `commandTimeoutMs` is refused. Pressing a gate or scenario again while its pulse waits for the panel is refused; for lights, dimmers and covers only the newest waiting command is sent, and the requests it replaces complete with its outcome (a dragged slider no longer shows an error for each step). A waiting light, dimmer or cover command can still go out up to `commandTimeoutMs` after the request when the previous one is slow to be answered. On a panel firmware that does not acknowledge output commands, a command that changes nothing (the light is already on) or goes to an output whose state was never reported now ends in a timeout, where 2.2.0 reported success; the panels observed so far acknowledge every command. Right after Homebridge starts, before the first synchronization has listed the devices, commands from cached accessories are refused. HomeKit and Matter show these as failed commands.
- **Thermostat writes send only what changes, and are refused when the target is unclear.** The configuration read at login is no longer written back. A write whose panel thermostat cannot be established (a `manualCommandPairs` entry for an ID the panel does not have, an unreadable configuration, an output no program uses, or on panels without thermostat programs a guess that is not the only one matching the live state: while several thermostats are in Auto or Off such panels need `manualCommandPairs`) fails with an error naming the `manualCommandPairs` line to add. Thermostat writes use `commandTimeoutMs` (8 s) instead of a fixed 2.5 s, and a temperature change is preceded by a read of about 250 ms. An MQTT setpoint outside `temperatureDefaults.min`/`max` is refused.
- **After the panel refuses the login 3 times in a row the plugin retries once per hour** instead of stopping until Homebridge is restarted. Fix the PIN and restart Homebridge to reconnect at once. Logins the panel does not answer (a restart, too many open sessions, the network) are retried with the normal backoff, as before.
- **MQTT.**
  - New retained topic `<prefix>/status` (availability of the bridge and of the panel, with an MQTT last will). **If your broker has an ACL, allow the plugin's user to write it** (`topic write homebridge/klares4/status`); without it the bridge still connects (if the broker refuses the last will, the bridge runs without it, says so once and tries it again every 30 minutes) but the availability topic is not written.
  - New `mqtt.commands` option; set it to `false` to publish state only. A value that is neither `true` nor `false` (`"false"` typed by hand) also turns commands off, with a warning.
  - The zone state payload has a new `tampered` field after `bypassed`; every earlier field keeps its name, value and order. A consumer that rejects unknown keys must accept it.
  - The broker URL must start with a scheme (`mqtt://`, `mqtts://`, `ws://`, `wss://`); a URL without one no longer connects. A password with `/`, `#`, `?` or `@` must be percent-encoded, or put in `mqtt.password`.
  - With `roomMapping` on, a command through the topic of the wrong room (or of a room for a room-less device) is refused; use the right room or `<prefix>/<type>/<id>/set`.
  - Devices whose names give the same topic now publish under their device ID (`.../<type>/<device id>/state`) and the shared retained topic is cleared; consumers that read them by name must switch.
  - Devices you excluded are no longer published (earlier retained topics are not cleared).
  - Invalid command payloads that used to be ignored silently now produce rate-limited warnings.
- **The debug file is confidential.** It is written `0600`, masks more (home position and sunrise/sunset times, account, serial numbers, panel identifier), and its log lines no longer invite you to share it. Send it privately. Each frame is now written once, as JSON text in `rawMessages[].rawData`: the `parsed` copy is gone, so a tool that read it must parse `rawData`.
- **Values of the wrong type in `config.json` are no longer interpreted.** A boolean written as text (`"true"`), a number as text (`"5000"`), a list as a single string falls back to its default, and the log says so at startup: fix the value in the plugin settings. In particular **`"allowInsecureTls": "false"` used to turn certificate verification off and now keeps it on**: if your panel's certificate is self-signed and `allowInsecureTls` was a string, the connection is now refused until you set it to `true` (the checkbox). Numbers outside the limits of the settings form are moved to the nearest limit (`maxSeconds: 3` becomes 5, `reconnectInterval: 0` becomes 1000); an invalid `port` or `mqtt.port` falls back to the default; `temperatureDefaults.step` must be 0.5 or 1.
- **The KSA import no longer rewrites your thermostat mappings.** Your `manualPairs` and `manualCommandPairs` win; the backup only adds the thermostats you have not mapped. If you relied on the backup overwriting a pair, delete that pair.
- **The Matter name list no longer expires 30 days after its last write**; names of devices still on the panel never expire, and the name of a device deleted on the panel stays reserved for 30 days after the panel last listed it.
- **Sensors the panel has not reported** (an offline DOMUS, for example) show "No Response" on HomeKit instead of 0 °C, 50 %, 100 lux or "no motion". Out-of-range or unreadable panel values are discarded instead of being moved to the nearest limit.
- **Files the plugin creates for the first time are private (`0600`);** existing files keep their permissions.
- **Requirements.** Node.js 22.12 or later (22, 24 and 26 are tested). Homebridge 2.5.x is the verified version, 2.4.x is covered by a CI contract job, and Homebridge 1.x is allowed by the package but **not tested**. The npm package no longer ships source maps.

### Security

- Outputs of an unrecognized category are no longer exposed as lights. Sirens, alarm bridges, indicators, generic relays, irrigation and outputs without a category used to appear in Apple Home, Alexa and on MQTT as lights that "turn off all the lights", scenes and automations could switch, with the stored PIN. They are hidden and cannot be commanded; `exposeOutputs` brings back a specific output.
- Scenarios are exposed by allowlist: only generic scenarios (`GEN`) run without an opt-in. A scenario with no category, an empty or non-text one, or an unknown one (for example `ARM_AWAY`) is neither exposed nor run with the stored PIN; `exposeScenarios` brings back a specific one. Arming and disarming scenarios are never exposed, and partial arming still needs `exposePartialArmScenarios`.
- Commands only reach outputs and scenarios the plugin discovered with that kind: a command for an output it does not expose (through an MQTT topic or a stale cached accessory) is refused and nothing is sent to the panel. Running a scenario follows the same policy as exposing it, and the refusal says why.
- The plugin sends nothing to a third party: the Sentry error reporting, its embedded DSN and the `@sentry/node` dependency are removed, and with them the global hooks it installed on the module loader inside the shared Homebridge process.
- The debug file is written readable by its owner only, masks the home position (including sunrise and sunset times), the account, serial numbers and the panel identifier together with the PIN, at any depth and in both directions; a frame that cannot be parsed is masked as text. Previously the login answer of the panel carried the GPS coordinates of the house into the file.
- The PIN is masked in the log whatever it contains and wherever it is: a PIN with quotes or backslashes, a number, a list or an object, a truncated frame, a payload carried as a JSON string. Every credential-like key (`PIN`, `PIN_CODE`, `USER_PIN`, `PASSWORD`, `CODE`, `TOKEN`, ...) is masked the same way, in any spelling (`userPin`, `PINCODE`, `PIN1`); the log and the debug file share one rule. The `LOGIN` frame is no longer written at every reconnection; at debug level it is logged masked.
- `allowInsecureTls` is on only for the JSON value `true`. `"allowInsecureTls": "false"` (or `"true"`, `1`) used to switch certificate verification off; it now keeps it on and logs which key was ignored. The same strictness applies to `exposePartialArmScenarios` and every other on/off option.
- A login refusal from the panel is recognised also when its answer does not carry the ID of the login: it was ignored, and a wrong PIN was retried every few seconds. After 3 refusals in a row the plugin slows down to one attempt per hour, so the panel does not lock the user out. A login left unanswered, a connection closed during the login or a network error is not a refusal: it stays in the normal backoff and never points at the PIN.
- Frames from the panel are checked before use: a plain-ASCII frame whose CRC does not match, a frame that is not a JSON object, has no `CMD` or a `PAYLOAD` that is not an object is dropped and logged. A frame with non-ASCII text (accented names) whose CRC differs is accepted and reported once, because the panel's encoding of those characters for the CRC is not verified yet. Frames larger than 4 MiB close the connection, which is re-established.
- New `mqtt.commands` option: `false` publishes state only and never subscribes to the `.../set` topics, so nobody who can publish on the broker can operate devices. A value that is neither `true` nor `false` turns commands off as well.
- The MQTT broker password no longer appears in the log (a URL that starts with a space or has no scheme included); only `scheme://host:port` is shown. A broker URL that mqtt.js would read as another host (no scheme, `mqtt:/host`, an unescaped `/` or `#` in the password, an unsupported scheme) is refused with a clear error instead of connecting to `localhost:1883`.
- With `roomMapping` on, a command on `<prefix>/<room>/<type>/<id>/set` runs only if the device belongs to that room, so a per-room ACL really limits what a client can operate.
- A device excluded with `excludeZones`, `excludeOutputs`, `excludeSensors` or `excludeScenarios`, or hidden by the exposure policy, cannot be commanded over MQTT, also while its accessory is restored from the HomeKit cache.
- MQTT setpoints outside `temperatureDefaults.min`/`max` are refused with a warning instead of being written to the panel (any value from 5 to 40 °C was accepted). A command carrying a mode and an out-of-range setpoint is refused as a whole.
- Files created for the first time (debug capture, KSA cache, Matter stores, device list, room mapping example) are private (`0600`). Temporary files used for atomic writes are created exclusively under an unpredictable name, and leftover ones from a crash (for `config.json` they contained the PIN) are removed at startup once older than five minutes.
- A `.ksa` backup is treated as untrusted input: IDs derived from it must be plain numbers, names are cut to 64 characters before they can reach `config.json`, and a file over 32 MB is refused.
- The release pipeline builds and tests in a job without publish rights and publishes the resulting tarball from a second job behind a protected environment; the tagged commit must be on `main`; a stable release requires a published release candidate with the same dependencies; all actions are pinned by commit SHA; Dependabot auto-merges only development dependencies and actions.

### Changed

- All titles and descriptions of the settings form are in English, and the form describes what the code does (see the corrected descriptions of `mqtt.port`, `logLevel`, `debug`, `commandTimeoutMs`, `domusThermostat.sensorFreshnessMs`, `temperatureDefaults`, `generateDebugFile`, `allowInsecureTls` and the KSA import switches).
- Every on/off option is read the same way: an option whose default is `false` is active only for `true`, and one whose default is `true` is inactive only for `false`. Any other value is ignored, the safe default applies, and one warning at startup names the key and the type it received.
- Numeric options are held to the limits declared in the settings form: a value that is not a number, not finite, or not an integer where one is required falls back to the default; a value outside the range is moved to the nearest limit, with one warning listing each correction. `matterUnregisterTimeoutMs` is held to its documented 500..30000 range.
- Configuration problems are reported once at startup, grouped in one warning, without ever printing the PIN, the MQTT password or the panel address. A `pin` that is neither a string nor a number is a clear error and the plugin does not start.
- The "hides N device(s) from Matter" warning of `matterOverrides` is logged when the first synchronization has finished and counts only devices the panel really reported. The one remaining Italian log message is now in English.
- Thermostats: the Matter Thermostat declares only the attributes of what the output can do (a heating-only or cooling-only output has no Auto and no opposite capability, and no Occupancy). A thermostat setpoint or mode change writes only what changes, like the official Ksenia web app; the whole configuration read at login is never written back. Thermostat writes use `commandTimeoutMs`. At a first start without a `.ksa` cache a Matter thermostat waits for the panel's program data (at most 20 seconds) before it registers.
- The KSA import adds the thermostat mappings of the backup that are missing and never replaces yours; when one of your pairs differs from the backup one log line names both values.
- The device summary and `klares4-room-mapping-example.json` are produced at the first synchronization and again only when the list of devices changes, not at every reconnection; the example file is written atomically and only when its content differs.
- The reconnection delay restarts from `reconnectInterval` only after a complete synchronization, not after a bare login. A `RESULT` in panel answers is read the same way everywhere (case and spaces ignored: a login answered with `ok` is accepted).
- Removal of HomeKit and Matter accessories follows the same rules, judged on each synchronization, reconnections included: an accessory counts as missing only if its kind of device answered in that sync, it is removed after three consecutive missed syncs, and a sync that sees fewer than half of the known accessories counts nobody as missing. The log line "Prune skipped for this sync ... (partial discovery)" is gone: a silent family now protects only that family.
- Debug capture keeps at most 5,000 frames and 2 MiB of traffic in memory; later frames are counted (`captureInfo.droppedMessages`), one warning is logged, and the capture still ends on time. The file is a few MiB at most: each frame is written once (`rawMessages[].rawData`), and a device snapshot taken during the capture is stored only if the devices changed since the previous one. The opening of covers (`status.position`) is kept in the snapshots; only the geographic position is masked.
- MQTT: the plugin schedules the reconnections itself (backoff from 5 s up to 60 s); `{"on":true,"brightness":40}` runs its two steps one after the other.
- A panel setpoint outside `temperatureDefaults.min`/`max` is shown on HomeKit at the nearest limit.
- Compiled for ES2022 (Node 22 and later, as before). The npm package no longer ships source maps (269 files and 254 kB instead of 521 files and 346 kB), and install size drops by about 95 MB of dependencies.
- CI runs on Node 22, 24 and 26, runs contract tests against the real Homebridge Matter stack on Homebridge 2.4.x and 2.5.x, enforces coverage thresholds and checks the package contents. Tests now run against the real Homebridge Matter stack, and the test device list is fully synthetic.

### Fixed

**Connection and synchronization**

- The initial synchronization is no longer reported complete when the panel refuses the realtime registration or the zones/outputs discovery read: the refusal is logged, and the plugin reconnects with backoff. Previously it stayed connected without ever receiving a status change. If the panel refuses the same discovery read in 3 synchronizations in a row, the synchronization completes without it: the other devices work, the devices of that read are neither discovered nor removed, and a warning names the read. A panel that never answers the realtime registration is reconnected after 60 s. The `PRG_THERMOSTATS` answer `CMD_NOT_AVAILABLE` that panels give at every login is not reported.
- Each login is a synchronization of its own: a reconnect whose discovery read fails can no longer count towards removing accessories. Two syncs completing in quick succession no longer run two overlapping Matter name refreshes and prunes.
- `reconnectInterval: 0` or a negative value no longer makes the plugin reconnect hundreds of times per second; `heartbeatInterval: 0` no longer drops the connection at every tick.
- When the panel stops answering pings (half-open connection), "disconnected" is reported at once and pending commands fail immediately, also with a short `reconnectInterval`. `connect()` always completes, and a shutdown during the login or while connecting is no longer logged as an error. A Homebridge shutdown during startup no longer lets the plugin connect afterwards.
- An error in the connection callbacks no longer leaves the session without heartbeat and without reading the panel data; an error in a raw-message listener no longer crashes the bridge.
- A malformed entry in a panel frame, or an error while handling one device, no longer drops the other devices of the same frame; the error is logged with the frame type, the device ID and a stack trace.
- An IPv6 address in `ip` now works. Statuses received for devices that were never discovered are kept for at most 512 IDs.
- A device deleted or re-categorised on the panel leaves the plugin's live state after the next complete discovery read, so its old twin no longer receives the status of the new device. A read in which an element could not be processed removes nothing.
- An output reconfigured on the panel (for example from `LIGHT` to `GATE`) is no longer kept with its old type until a restart, so a former light that is now a gate is not switched by "turn on all the lights".
- HomeKit, MQTT and Matter are handled independently for each device: an error on one no longer keeps a device from being registered or published elsewhere.
- Bridges with more than 149 devices: Homebridge's HomeKit bridge refuses accessories beyond 149. The plugin logs one clear warning, and the devices beyond the limit are still exposed on Matter and published on MQTT instead of being lost together with every device discovered after them. An accessory refused by HomeKit no longer leaves an internal handler behind.

**Commands**

- Commands no longer go out late; pressing a gate or scenario again while the previous pulse waits is refused at once; for lights, dimmers and covers only the latest command is sent, the requests it replaces complete with its outcome instead of failing, and the number of commands waiting per device is capped.
- A light, dimmer or cover command is confirmed by the panel's realtime state only when the output actually changes to the requested state after the command. A state the output already had, or the late event of an earlier command, no longer counts; a refusal from the panel always wins. Empty or blank positions are no longer read as 0, and a malformed status entry no longer throws.
- `NaN`, `Infinity` or a non-number brightness or position, and an on/off that is not a boolean (`"false"`), are refused instead of turning into "close", "off" or "on".
- A command acknowledged without `RESULT=OK` is a failure for every command that changes something on the panel, and a command sent without any confirmation is reported as an error, never logged as success. A panel answering with a numeric response ID is matched to the right command even with several pending.

**Panel values**

- A sensor value the panel reports as missing or unreadable (`NA`, empty, not a number) no longer turns the discovery placeholder (0 °C, 100 lux) into a real reading on HomeKit, Matter and MQTT; the device stays "not yet observed" until a valid reading arrives.
- Out-of-range or unreadable values are discarded instead of being moved to the nearest limit: a probe reporting 999 °C, a humidity of 150 %, a cover position of `abc` or 300 no longer become 100 °C, 100 %, "closed" or "open". A cover update without a readable position keeps the last position instead of jumping to 50 %. Lights accept `ON`/`OFF` in any case; a zone update carrying only some fields changes only those fields.
- Zone tamper: the panel's `T` field is now read, shown as HomeKit `StatusTampered` and published on MQTT as `tampered`.
- The panel's own temperature probes are no longer removed from HomeKit when the panel reports `NA` for them.

**Configuration**

- `excludeZones`, `excludeOutputs`, `excludeSensors` and `excludeScenarios` accept what users write: numbers (`5`), strings with spaces (`" 5"`) and full device IDs (`"gate_5"`, `"light_5"`, `"zone_3"`). A value that is not a list is ignored with a warning instead of matching by substring or throwing; an entry that is not a device ID of that kind is dropped and named.
- `matterOverrides`, `matterRecoveryRequests` and `customNames` in their legacy map form are validated like the array form: a `null`, a number or a non-string name no longer stops the platform from starting or breaks the MQTT topics, and a device ID such as `constructor` no longer picks up a name from the object prototype. Two `matterOverrides` rows for the same device are merged (a conflict is warned about, the last value wins).
- After the first synchronization one warning lists the `matterOverrides`, `matterRecoveryRequests` and `customNames` entries that match no device on the panel, with a hint when the ID is only a number or in capitals.
- `config.json` that is a symbolic link stays a link. When it cannot be replaced atomically (a single-file Docker bind mount, `EBUSY`) the plugin rewrites it in place and warns, instead of failing silently and leaving `generateDebugFile` or the KSA `applyAtStartup` switched on forever. The plugin no longer reports "KSA import applied" or "Debug flag disabled" when the write did not happen. With more than one `Lares4Complete` block the one of the running instance is updated. In the KSA import, custom-name rows that are not objects are dropped instead of being rewritten as `{}`.
- A damaged cached accessory no longer stops Homebridge from restoring the plugin's other accessories; it is reported with a warning and realigned at the next discovery. Accessories excluded in the config get no handler from the cache. Old Matter prune counters of accessories that no longer exist are cleaned from `klares4-matter-prune.json`.

**HomeKit**

- Sensors the panel has not reported show "No Response", also after a Homebridge restart: a DOMUS sensor or a cover position the panel never reported no longer comes back from the cache as 0 °C, 50 %, 100 lux or position 0 (whether the panel reported a value is now stored with the accessory, on HomeKit and Matter). Setting the brightness of a light that is not dimmable is an error instead of a silent success. A cover whose position has not been reported yet always sends the command.
- A scenario renamed on the panel is updated in its HomeKit handler (the MQTT command by the new name works without a restart). The HomeKit gate auto-off uses `scenarioAutoOffDelay` instead of a fixed 500 ms.
- Accessories cached by an older version for devices the exposure policy now hides are removed from HomeKit at the first sync, also when the panel has only arming scenarios.

**Thermostats**

- Setting a thermostat temperature or mode no longer writes back the whole configuration read at login. A setpoint from HomeKit, Matter, Alexa or MQTT could switch heating back on after it was turned off on the keypad, drop a weekly program, and undo schedule, comfort-temperature or season changes made since the plugin connected. The plugin now sends only what the command changes: a mode change only the mode (and the season, only when Heat or Cool needs the other one), a temperature change re-reads that thermostat right before writing and sends only the active season's block with the new temperature. The plugin also notices configuration changes made on the panel and re-reads before using the configuration again.
- Automatic thermostat ↔ DOMUS sensor matching by name no longer gives one room's sensor to another room with a similar name.
- A reconnection no longer replays the thermostat configuration of the previous session over the live state (no more spurious heat → off transitions or AUTO targets jumping to the manual setpoint at every reconnect). In AUTO the target shown is always the program's.
- A thermostat's current temperature is no longer replaced by the panel's internal board temperature when the room temperature simply stays the same for more than 5 minutes, and is no longer published for a moment at every start.
- A temperature or mode changed from HomeKit (or MQTT) now reaches Matter and the MQTT state topic as soon as the panel acknowledges it. HomeKit "Current Heating/Cooling State" in AUTO follows the season. A mode and a temperature sent together become one panel write, applied in the right order; two accessories sharing one panel thermostat no longer overwrite each other. An acknowledged "cool" that the panel never confirmed no longer moves later setpoints to the summer season. A realtime mode the plugin does not know is no longer shown as a frozen mode.
- A temperature set from HomeKit, Matter or MQTT while the thermostat is in Auto or Off is stored as its manual setpoint and does not switch it on; HomeKit, Matter and MQTT then show again the target the panel is really using, with a line in the log, instead of the value requested.

**Matter**

- Thermostats register as real Matter thermostats again on Homebridge 2.5, where every thermostat had fallen back to a temperature sensor after about 30 seconds and `matterRecoveryRequests` could not bring it back. The plugin declares only the attributes of what the thermostat can do and, if a Homebridge version does not accept that, tries once with the payload of 2.2.0 before falling back. Thermostats saved as a fallback get one automatic attempt at the first start; if Homebridge still refuses, the sensor comes back with its previous identity. On Homebridge versions that accept only the earlier payload, the plugin remembers which payload worked instead of having every thermostat refused and retried at each start.
- A heating output and a cooling output of the same program no longer act on each other in Matter: the role comes from the program data, not from the device name, so renaming a thermostat no longer changes what it can do. Auto (and Cool) on a heating-only thermostat is refused to the controller instead of being accepted and ignored. Matter thermostats publish whether the heating or cooling output is running.
- A Matter command sent shortly after another is no longer dropped as "already current" because the panel had not reported the first yet (two quick +1 °C steps now add up to +2 °C), and a step given right after a change made on the keypad or in HomeKit starts from that change. A command that cannot reach the panel is reported as failed and the previous value comes back. A Matter thermostat whose room temperature has not been read shows it as unknown instead of a made-up 20 °C.
- The Matter fallback store no longer rewrites a file it does not understand; an unreadable file is copied to `klares4-matter-fallback.json.unreadable.bak` before a new store starts.
- Renaming a Matter accessory (a name changed on the panel, a `matterOverrides` name, a collision resolved at the end of the first sync) no longer removes it from the bridge and adds it back: the name is changed on the live accessory, which keeps its identity, so controllers keep rooms, favourites and automations. A light that turns out to be a dimmer is still replaced once but keeps its identity.
- A device deleted or renumbered on the panel is removed from Matter after three complete syncs, also across Homebridge restarts (before, an endpoint restored from Homebridge's cache stayed forever, shown as reachable, with commands failing).
- When the panel is unreachable every Matter accessory is marked "not responding" after 15 seconds, including those restored from Homebridge's cache. They become reachable again only when a synchronization has completed, not at the login.
- A Matter command (light, dimmer, cover, thermostat setpoint or "+1 °C") no longer fails towards the controller with an internal lock error when the plugin is updating the same accessory at that moment; the panel used to carry out the command while Apple Home or Alexa reported it as failed. A command that arrives during such an update now waits for it, up to about 150 ms more.
- Covers commanded from Apple Home, Alexa or Google no longer show as already open/closed the moment the command is sent: they keep the position the panel reports, show the requested target, and report opening or closing until they have moved. A brightness command on a dimmer that is off no longer reaches the panel. A Matter command arriving while the panel is unavailable fails visibly.
- An out-of-range or non-numeric value restored from an old Homebridge cache no longer makes an accessory fail to register for the whole session.
- The Matter name list is written atomically, a list written by a newer version is left untouched after a downgrade, and names of devices still on the panel never expire. Matter names with characters outside the Basic Multilingual Plane are shortened the way Homebridge counts them, so two accessories cannot end up with the same truncated name. Very long names no longer block Homebridge for seconds, and the voice-name analysis is much faster on large installations.
- On Homebridge versions whose Matter registration completes before returning (2.5), an accessory that did not come up is retried after about 2 seconds instead of 30; an endpoint counts as up only when it answers for every cluster the plugin declared.

**MQTT**

- A burst of MQTT commands no longer keeps the panel busy for minutes: for each device one command runs and only the newest waits.
- After a refused connection (wrong password, broker restarting) the bridge keeps retrying instead of stopping until Homebridge restarts; a broker that is down no longer writes two log lines every 5 seconds. At a Homebridge shutdown after a broker interruption the bridge closes within 2 seconds instead of waiting for messages the broker never confirmed.
- Two devices whose names give the same topic, or a name without letters or digits, no longer overwrite each other's retained state.
- Invalid MQTT commands are refused with a warning that says what is expected; topic levels and payloads in the log are quoted and cut to 80 characters, so a client cannot inject fake log lines; a QoS 1 retransmission of the same command is not executed twice; a `topicPrefix` containing `+` or `#` is refused at startup.
- A command refused by validation or the panel queue is logged as a readable warning instead of a generic error.

### Added

- `exposeOutputs` and `exposeScenarios`: per-device opt-in lists for outputs and scenarios of an unrecognized category, with a startup warning that lists every hidden device, its category and the exact entries to add (repeated only if the situation changes).
- The panel's per-scenario PIN flag is read: exposed scenarios with a flag other than `N` are listed in the startup warning for you to check.
- `mqtt.commands`.
- `<prefix>/status`: retained availability of the bridge (`online`/`offline`, with an MQTT last will) and of the panel connection (`connected` once a synchronization has completed).
- `tampered` in the MQTT zone state payload.
- Matter thermostats publish their running state; a heating-only or cooling-only Thermostat is exposed with only that capability.
- Documentation: `docs/en` and `docs/it` are the same nine pages, with new MQTT, Matter and privacy pages; the README lists every setting with its default and limits in both languages; `SECURITY.md` is current.
- Tests: `npm run test:contract` (Matter contract tests against the real Homebridge Matter stack), `npm run test:coverage` (coverage thresholds on `src/`), `npm run check:pack` (tarball contents).

### Removed

- The `telemetry` setting and the anonymous error reporting (Sentry), with the `@sentry/node` dependency (23 packages). A `telemetry` key in an existing `config.json` is ignored.
- The `ksaImport.applyExclusionSuggestions` setting (it never changed anything). An existing value is ignored.
- The `release:rc` and `release:beta` npm scripts, which published from a local machine without provenance. Releases are published only by the workflow.
- The "Prune skipped for this sync (partial discovery)" log line, replaced by per-family protection.

## [2.2.0] - 2026-11-14

Stable release of the `2.2.0-rc.1` … `2.2.0-rc.4` cycle. It also carries the `2.1.5-rc.1` and `2.1.5-rc.2` fixes, which never reached a stable release, so it is the upgrade from `2.1.4`. `2.2.0-rc.4` was validated on a real Lares4 panel (Homebridge 2.4.0, Node 24, Matter-only child bridge with 109 endpoints paired to Apple Home, Alexa and Google). Per-rc detail is kept below.

### Upgrading from 2.1.x: read first

- **Node.js 22.12 or newer is required.** Node 20 and Node 22.0–22.11 are no longer supported.
- **Partial-arm scenarios are hidden by default** from HomeKit, Matter and MQTT, because triggering one used the stored PIN without any authentication. Upgrading removes them; set `exposePartialArmScenarios: true` to keep them.
- Setting a thermostat temperature keeps the current mode (OFF stays OFF, AUTO keeps its program) instead of switching to manual.
- `customNames` is now a list of `{ deviceId, name }` rows. The legacy map is still read, but the Homebridge UI deletes it on its next save.
- A KSA import no longer switches `roomMapping` on by itself.
- An HTTPS panel on Node 24 may need `allowInsecureTls: true` (self-signed certificate, TLS legacy renegotiation); the log now says so when it is missing.

### Highlights

- **Matter on Homebridge 2.4:** renames, pruning and thermostat recovery take effect, dimmers are `DimmableLight`, covers show movement, accessories turn unreachable when the panel is lost, and per-device Matter names and exposure (`matterOverrides`) survive the Homebridge UI.
- **Security:** PIN masked whatever its type, login stops after 3 rejections so the panel does not lock the user out, MQTT credentials masked, and a private Sentry client.
- **State and commands:** see `2.2.0-rc.4` below for the full list of fixes.

### Fixed since 2.2.0-rc.4

- A panel that needs TLS legacy renegotiation or has a self-signed certificate no longer fails with only a raw OpenSSL error (`unsafe legacy renegotiation disabled`): the log explains that `allowInsecureTls` fixes it, once rather than on every reconnect, and these setup errors are no longer sent as error reports (#37).

### Changed since 2.2.0-rc.4

- Node.js 22.12 or newer is required (`engines.node >= 22.12.0`), the minimum of `@sentry/node` 11 and of Homebridge's own `hap-nodejs`. Node 22.0–22.11 are no longer supported.
- Anonymous error reporting moves to `@sentry/node` 11. The events sent and the privacy filtering are unchanged.

## [2.2.0-rc.4] - 2026-09-26

Stability and compliance release, validated on a real Lares4 panel with Homebridge 2.4.0 on Node 24 (Matter-only child bridge, 109 endpoints). Read **Security** and **Changed** before upgrading.

### Security

- Partial-arm scenarios (category `PARTIAL`) are no longer exposed to HomeKit, Matter or MQTT by default. Triggering one used the stored PIN, so a voice group command, a scene or a stray MQTT message could arm part of the alarm without any authentication. Set `exposePartialArmScenarios: true` to keep them, accepting that trade-off. Arm/disarm scenarios are never exposed, and the plugin refuses to run any arming scenario even from an old cached accessory. Upgrading removes previously exposed partial-arm scenarios from HomeKit and Matter.
- A PIN typed as a number in `config.json` is masked in the log, the debug capture and telemetry.
- After 3 rejected logins in a row (wrong PIN or disabled user) the plugin stops reconnecting, so the panel does not lock the user out, and logs how to fix it. Restart Homebridge after correcting the PIN.
- Anonymous error reports use a private Sentry client, so other plugins in the same Homebridge process can neither take them over nor mix their events in. Stack traces and messages no longer contain home-directory paths.
- MQTT broker credentials embedded in the broker URL are masked in the log.

### Changed

- **Node.js 22 or newer is required** (`engines.node >= 22`). Node 20 is end-of-life and Homebridge 2.4 no longer supports it. CI tests Node 22 and 24.
- Setting a thermostat temperature no longer switches the thermostat to manual: an OFF thermostat stays off and an AUTO thermostat keeps its program; only the setpoint of the active season changes. On an AUTO thermostat the live target may therefore not move until the thermostat is in manual mode.
- `customNames` is edited in the Homebridge UI as a list of `{ deviceId, name }` rows. The legacy per-category map is still read, but the UI deletes it on its next save, so move to the list form. `sensor_system_temp_in` / `sensor_system_temp_out` can now be renamed, targeted by `matterOverrides` and excluded.
- Bypassed zones are no longer shown as "tampered" in Apple Home; they appear as inactive.
- HomeKit accessories are removed only when their category answered the discovery and they have been missing for 3 consecutive syncs (as on Matter). Devices excluded in the configuration are still removed at once.
- A KSA import turns panel room names into MQTT-safe slugs, never replaces rooms you defined and no longer switches `roomMapping` on by itself. If you relied on that implicit switch, enable `roomMapping` yourself or your MQTT topics lose the room level.
- The settings UI no longer writes `port: 443`, an empty `matterRecoveryRequests` row or a fixed MQTT `clientId` on every save. `mqtt.port` and `domusThermostat.manualCommandPairs` are now in the UI, so saving keeps them.

### Fixed

#### Matter

- Every unregister was a no-op on Homebridge 2.4: renames, stale-endpoint pruning and explicit thermostat recovery never removed an endpoint (the plugin passed a bare `{ UUID }`; Homebridge reads `accessory.deviceType` first).
- An endpoint is re-registered under the same ID only after Homebridge has really released it. Homebridge reports an endpoint as absent while it is still closing it but keeps the ID reserved, so the register that followed was rejected as "already registered" and a rename took a retry and about 30 seconds.
- Registrations are serialized per device: a status update during an explicit thermostat recovery no longer registers the same device twice.
- Saving the plugin settings from the Homebridge UI no longer hides every `matterOverrides` device from Matter. The "Exposed on Matter" checkbox had no default, so the UI wrote `exposed: false` on every row and those devices were pruned after a few restarts. The box is now ticked by default and devices hidden by an override are listed in a startup warning, so configurations already affected can be spotted.
- Dimmers are exposed as `DimmableLight`, including when the panel reports the level while registration is still in progress; they were always on/off.
- Window coverings show movement and the real target position while moving.
- Toggle, open/close, step and stop commands no longer fail with "No handler registered". Setting a dimmer to the minimum level no longer turns it off. Stopping a cover mid-travel is refused explicitly, because the panel cannot stop there.
- Thermostat commands are no longer dropped after the panel changed the setpoint or mode; raise/lower respects heat/cool; in cool mode the target is shown as the cooling setpoint; a refused command no longer leaves the refused value displayed, and retrying the same value is no longer ignored.
- Accessories show as unreachable when the panel connection is lost for more than 15 seconds.
- New sensors show "unknown" until the first real reading instead of 0 °C / 0 lux.
- Names changed while Homebridge was offline reach the controllers after the restart.
- Accessories refused while the Matter server was still starting are registered on a later update.
- A rare name collision can no longer hang Homebridge while resolving Matter names.
- Scenarios hidden by the arming policy are removed from Matter after 3 syncs; previously the cache-restored endpoints stayed in the controllers forever, unusable.

#### State and commands

- Boots and reconnects no longer publish placeholder states. Each login re-reads the configuration and every re-read device replaced the known one with parser defaults, so HomeKit and Matter briefly saw lights off, covers closed, open windows closed, 0 °C sensors and 20 °C thermostats, enough to fire automations.
- Thermostat setpoints are written to the season the panel is actually in, including on panels whose thermostat and DOMUS sensor numbers differ. After a restart a summer setpoint was lost while the panel acknowledged the write, and a rejected `cool` command could switch the thermostat to summer on the next setpoint.
- When the panel does not provide thermostat programs, a thermostat write whose target cannot be determined safely is refused with instructions for `domusThermostat.manualCommandPairs`, instead of possibly changing another thermostat.
- A gate, light or cover command sent right after a (re)connection is no longer reported as failed because of an unrelated panel reply, and replies are matched to their own command on firmware that shortens the command ID.
- A late or duplicate panel response for a finished command is no longer attributed to another pending command; a stray login response no longer restarts the session.
- A late `close` from a socket replaced during a reconnect no longer marks the new connection as disconnected.
- A rare error path in output commands could restart the Homebridge bridge.
- Reconnecting to an unreachable panel gives up after 10 seconds per attempt instead of hanging for about 2 minutes; shutting down during a reconnection no longer starts another attempt.
- After an outage, the first reconnection is no longer torn down by a heartbeat left over from the dead socket ("Heartbeat timeout: no PONG received" right after "WebSocket connected"), which cost an extra reconnection cycle.
- Commands containing emoji or other characters outside the basic range get a correct CRC.

#### HomeKit

- The thermostat shows "Heating"/"Idle" from the panel's real output on every update, and remembers the chosen display unit.
- Cover target position follows commands sent via MQTT and movements started from the panel; choosing the current position while a cover moves stops it there; a failed move no longer leaves the cover "Opening…"/"Closing…".
- Cover and gate accessories can no longer send a command while they are created at startup.
- Dimmers discovered on a fresh install accept brightness changes without a restart.
- Thermostat writes issued before the WebSocket client exists fail instead of reporting success.
- Renames reach every HomeKit name, cached names from older versions are corrected, and names HAP-NodeJS would reject (a trailing apostrophe, a single character) are fixed; Matter names are unchanged.

#### MQTT

- Brokers given as `mqtts://host:8883` or `ws://…` URLs connected to port 1883; the URL port (or the protocol default) is used unless `mqtt.port` is set.
- Commands work with any `mqtt.topicPrefix` depth.
- Username-only authentication is sent.
- A thermostat command with both `mode` and `targetTemperature` applies the mode first; if the mode is refused the setpoint is skipped.
- Commands published with `retain=true` are ignored with a warning instead of running again at every reconnect; room names with `+`, `#` or `/` are published with `_`.
- State is no longer queued in memory without limit while the broker is unreachable; the latest state is republished on reconnect, and a device renamed while the plugin runs has its old retained topic cleared.
- The MQTT bridge and the debug capture start even when the panel is unreachable at boot.

#### Configuration and files

- `customNames` survives the Homebridge UI (it was deleted on every save), and a KSA import with `applyCustomNames` only adds names, never overriding one you set.
- The KSA import no longer erases your `exclude*` lists with `applyExclusionSuggestions`.
- `config.json` is rewritten atomically, keeping its permissions and formatting, when the plugin resets `generateDebugFile` or `ksaImport.applyAtStartup`, also when the platform is listed as `homebridge-plugin-klares4.Lares4Complete`.
- An incomplete `klares4-ksa-cache.json` is ignored with a warning instead of stopping the plugin from connecting; a malformed entry in a `.ksa` backup is skipped instead of aborting the import.
- Matter fallback and prune stores written by a newer version are no longer overwritten after a downgrade; all plugin state files are written atomically.
- A restart during a debug capture no longer loses the file; the device list is flushed at shutdown; the debug file reports the running plugin version.
- The startup device summary shows the exact value to put in the exclusion lists.

## [2.2.0-rc.3] - 2026-09-12

### Fixed

- `matterOverrides` and `matterRecoveryRequests` survive the Homebridge UI. Both were declared as free-form objects keyed by device ID — a shape the UI cannot render, so it silently dropped them whenever `config.json` was rewritten from the settings form. Saving any unrelated setting (turning off debug logging, for instance) deleted a live override block. Both keys now use an array of typed entries (`{ deviceId, name, exposed }` and `{ deviceId, generation }`) that the UI renders and round-trips; the previous map form is still accepted so existing configurations keep working.

### Changed

- The unregister observation budget now defaults to 3s instead of 10s and is configurable via `matterUnregisterTimeoutMs`. On Homebridge 2.x betas `unregisterPlatformAccessories` given a `{ UUID }` stub often removes nothing, so the full budget was spent on every rename that could not succeed — 18 pending renames cost three minutes of startup.

## [2.2.0-rc.2] - 2026-09-12

### Fixed

- Matter renames work again. `unregisterPlatformAccessories` is handed a `{ UUID }` stub with no metadata and can reject while having removed the endpoint; that rejection escaped and aborted the entire name-finalize pass on the first device, so every rename queued behind it was never attempted and configured `matterOverrides` had no visible effect. The coordinator now treats a rejection as no evidence either way — local observation decides — and each device is isolated, so one failed rename leaves that endpoint on its previous name instead of cancelling the rest.

## [2.2.0-rc.1] - 2026-09-12

Additive capabilities on top of `2.1.5-rc.2`: naming provenance, read-only
voice diagnostics, serialized Matter topology and explicit thermostat
recovery. Default behaviour is unchanged without new configuration.

### Fixed

- Matter topology mutations are serialized. An unregister is considered complete only once local endpoint disappearance is observable, and a rename additionally waits for the new endpoint to become locally queryable — so overlapping rename, prune and recovery bursts can no longer race. This verifies local publication only; what a voice controller has actually indexed stays unknown to the plugin.
- Persisted thermostat fallbacks use versioned records, with legacy entries migrated as `legacy-unknown`. The previously sticky fallback can now be cleared through a restart-safe, one-shot recovery request that reuses the same device ID and rolls back to `TemperatureSensor` on any failure.

### Changed

- Custom names are now applied to a derived copy of each device instead of mutating the discovered device in place. A Matter-only override therefore changes the Matter name alone: the name shared with HomeKit and MQTT is unaffected. As a consequence `klares4-devices.json` consistently lists the panel's own names, instead of a mix that depended on discovery order and write debouncing — making it a reliable reference when filling in `customNames`.

### Added

- Read-only Italian-aware Matter voice-collision diagnostics with deterministic summary hashes and debug-level evidence. It reports lexically ambiguous names, including names whose distinctive part is lost to the 32-character limit. Nothing is renamed and no exposure changes.
- Per-device Matter-only `name` and `exposed` overrides through `matterOverrides`, resolved by a single exposure policy: global exclusion, then per-device override, then category, then the existing default.
- Administrative `matterRecoveryRequests` generations for controlled, per-thermostat recovery. Inert until a generation is configured; incrementing it authorises exactly one attempt.

## [2.1.5-rc.2] - 2026-09-12

Command-path correctness and persisted-name integrity. Reconciles the
reservation and prune-guard work that shipped in `2.1.5-rc.1` (a pre-release tag
with no entry of its own: its content is described here) but was never present
on `main`.

### Fixed

- Mutating output and thermostat commands now resolve only on a real terminal outcome. Explicit `FAIL`, `ERROR`, `CMD_NOT_AVAILABLE` and timeout results reject instead of being logged as successful. Pending commands correlate on an exact ID first, fall back to a single unambiguous candidate only, and refuse duplicate IDs.
- Light, dimmer and cover writes may also complete from a matching realtime state update, for firmware revisions that never emit `CMD_USR_RES` for outputs. Gate and scenario commands require an acknowledgement, since they have no observable state.
- Persisted Matter names are now a validated, atomically-written v2 store with v1 backup and migration, 30-day reservations, NFKC normalisation, code-point-safe truncation, re-checked collision suffixes and deterministic repair of invalid or duplicate records. Valid names are preserved byte-for-byte.
- A prune pass is skipped entirely when discovery returned fewer than half the exposed registered endpoints, so one disturbed sync can no longer cascade into a mass unregister.

## [2.1.4] - 2026-07-25

Stable release of the **`2.1.4-rc.1` … `2.1.4-rc.7`** cycle, running in
production for over a week on a Matter-only child bridge with no regressions.
Aggregates the fixes shipped over the seven release candidates below;
per-rc detail is preserved further down for archival reference.

### Fixed — Matter/Alexa topology stability (production-critical)

- **Conservative stale pruning, now durable across restarts.** `pruneStaleAccessories` no longer unregisters a Matter accessory after a single missing discovery cycle — a new `MatterPruneTracker` requires 3 consecutive missing cycles, and the counters are **persisted** (`klares4-matter-prune.json`) so the discipline holds across boots too, not just within one. Realtime status updates mark a device as seen in the current cycle, so an accessory that keeps pushing state can never be pruned by a partial discovery. The HAP-side pruner additionally refuses to run when a sync discovers zero devices, so a failed/partial sync can no longer wipe every cached HomeKit accessory in one shot.
- **Deterministic voice-command names.** Two-phase batch name resolution (`matter-name-map.ts` / `matter-name-service.ts`) computes the final `uuid → displayName` map for the *whole* device set before any registration happens, replacing the old "register clean, rename after" mechanism that left a window on every boot where two devices shared the same name — the root cause of Alexa/Siri sometimes resolving the wrong accessory ("il dispositivo non risponde"). The map is persisted to `klares4-matter-names.json` and reloaded at construction, so from the second boot on every accessory registers with its final name immediately. Name-slot matching is case-insensitive end-to-end, including the incremental fallback path used for devices not yet in the map.
- **Stable output classification.** A new `OutputTypeMemory` remembers the last confidently-classified type per Klares4 output id, so a partial/ambiguous re-poll (missing `CAT`/`MOD`) can no longer flip an already-known output's type — and therefore its `device.id`/UUID — making Matter/Alexa perceive a brand-new device for the same physical output.
- **Diagnostics.** Compact per-cycle Matter topology summary log (`discovered`/`registered`/`newlyRegistered`/`cachedRestore`/`metadataChanged`/`metadataUnchanged`/`missingCandidates`/`pruneSkipped`/`unregistered`) plus an explicit end-of-sync WARN for any pair of final names equal case-insensitively (which cannot happen by construction) make future incidents diagnosable from logs alone.

### Changed — Matter accessory naming & collisions

- **Sanitiser switched from blocklist to HomeKit-safe allowlist**, guaranteeing HAP-NodeJS `checkName` compliance across Apple Home, Alexa and Google Home; apostrophes (`'`/`’`) are preserved.
- **Priority-based collision resolution.** Controllable device types (cover/light/thermostat/gate/scenario) now win the clean name over zone/sensor on collision, with a stable `device.id` tie-break so the same device set always converges to the same names regardless of discovery order — e.g. `Device 69` (cover) keeps the clean label, `Device 69` (zone) becomes `Device 69 - Sens.`.
- **Abbreviated, anti-redundant collision suffixes** (` - Sens.`, ` - Tapp.`, ` - Luce`, ` - Term.`, ` - Scenario`, ` - Cancello`) avoid the mid-word truncation and self-referential suffixes (`Device 63 - Tapparella`) seen in earlier candidates.
- **Name hygiene at the source.** `DES` is trimmed/whitespace-collapsed at parse time for outputs, zones, scenarios and the DOMUS sensor triple (`… - Temperatura` / `… - Umidita` / `… - Luminosita`), so stray panel whitespace never leaks into HAP names, MQTT payloads or the Matter sanitiser.

### Fixed — Matter scenarios invisible on Alexa

- Scenarios/gates were registered as Matter `OnOffSwitch` (a spec-defined client device), which Alexa silently drops and which left Apple Home's cluster latched "ON" after one tap. Switched to `OnOffOutlet` (`OnOffPlugInUnit`) — scenarios now appear under **Plugs** in Alexa and remain re-tappable in Apple Home via the existing momentary auto-off.

### Added — Opt-out telemetry (Sentry), with value-level PII scrubbing

- Anonymous error reporting (`telemetry: true` by default, disable via config) to help track unhandled exceptions and bugs.
- `beforeSend` scrubs both keys and **values**: IPv4 addresses, `ws(s)://`/`http(s)://` URLs, the exact config-derived secrets (`ip`, `pin`, `sender`) and the machine `server_name` are redacted from `event.message`, exception values, breadcrumbs and `extra`/`contexts` — network errors like `connect ECONNREFUSED <panel-ip>:443` no longer leak the panel address.

### Changed — Boot I/O

- `klares4-devices.json` writes are now debounced (1 s after the last discovery event) instead of once per discovered device (~109 racing writes on the reference install), with startup summary timing unchanged.

### Tests

- **225/225 passing.** Coverage added across the cycle: Matter device-type mapping and auto-off scheduling, name-sanitiser HAP `checkName` compliance, batch name-map determinism across discovery-order permutations (incl. the full 109-endpoint production fixture), persisted prune counters across simulated boots, status-updates-keep-alive prune guard, HAP empty-sync prune guard, telemetry value-scrubbing, and DES normalisation at parse time.

### Compatibility

- UUIDs, serial numbers and Matter part identities are unchanged for all existing devices; no changes to `_bridge`/commissioning/Matter storage; config keys are additive (`matterExposure`, `debugCaptureDurationMs`, `telemetry`); MQTT topic shapes untouched. User-visible name changes are limited to removal of stray whitespace and, on installations with label collisions, suffixed *sensor* names now applied from the first registration instead of after it.

---

### Per-RC archival history

#### [2.1.4-rc.7] - 2026-07-16

### Fixed — Telemetry: value-level PII scrubbing (Sentry)

- `beforeSend` now scrubs **values**, not just keys: IPv4 addresses (with optional port) and `ws(s)://`/`http(s)://` URLs are redacted from `event.message`, every `exception.values[].value`, breadcrumb messages/data and string values in `extra`/`contexts`. Network errors like `connect ECONNREFUSED <panel-ip>:443` no longer leak the panel address — the README promise ("no IP is ever transmitted") now holds for error texts too.
- The exact config-derived secrets (`ip`, `pin`, `sender`) are passed to `initTelemetry` and redacted verbatim (case-insensitive) from every outgoing text field — this also covers hostname-based setups (`getaddrinfo ENOTFOUND lares.local`).
- `server_name` (the machine hostname Sentry attaches by default) is removed from every event.
- Key-based scrubbing extended to compound keys (`ipAddress`, `hostname`, `deviceName`, `roomName`).
- Docblock fixed: `initTelemetry` now documents the actual opt-out semantics (default enabled, `telemetry: false` disables) instead of claiming opt-in.

### Fixed — Matter prune discipline effective across restarts

- **Persisted missing-cycle counters** (`klares4-matter-prune.json`): on a stable connection the plugin runs exactly one discovery+prune cycle per boot, so the in-memory 3-consecutive-cycles counter could never cross the threshold across restarts — a type disabled via `matterExposure` (or a genuinely stale cached endpoint) survived forever. Counters now persist and are cleared as soon as the device reappears; the discipline is unchanged (still 3 consecutive cycles), it just counts for real across boots.
- **Realtime state keeps a device alive**: `updateAccessoryState` now marks the device as seen in the current discovery cycle, so an accessory that keeps pushing status updates can never become a stale-prune candidate because of a partial discovery — closing a potential churn loop (unregister at threshold → re-register on the next status update).
- **HAP-side prune safety net**: `pruneStaleAccessories` (HAP bridge) skips the pass entirely when the sync discovered *zero* devices — a failed/partial sync can no longer wipe every cached HomeKit accessory (rooms/automations) in one shot.

### Fixed — Matter name registry: case-insensitive slots

- The incremental `MatterNameRegistry` (fallback path for devices not in the persisted map) matched name slots **case-sensitively**, while the authoritative batch map is case-insensitive — a case-different duplicate ("Device 70" vs seeded "Device 70") could briefly hold two equal voice names until the next finalize. Slot keys are now lowercased, aligning both paths.
- Typed-suffix roots are regex-escaped in `nameAlreadyMentions` (robustness for future suffix entries containing metacharacters).

### Fixed — Name hygiene: DOMUS sensors

- The DOMUS sensor triple (`… - Temperatura` / `… - Umidita` / `… - Luminosita`) built its base name from the raw `DES`, bypassing the rc.6 parse-time normalisation — trailing/multiple spaces could re-enter HAP/MQTT names via `BUS_HAS`. Now normalised like every other parser.

### Changed — Boot I/O

- `klares4-devices.json` was rewritten once per discovered device (N racing async writes per sync, ~109 on the reference install). Writes are now debounced (1 s after the last discovery event): one write per sync, startup summary timing unchanged.

### Tests

- **225/225 passing (10 new):** telemetry value-scrubbing (IP/URL redaction, config-derived secrets, `server_name`, compound keys), case-insensitive registry slots, status-updates-keep-alive prune guard, persisted prune counters across three simulated boots (including counter reset on reappearance), HAP empty-sync prune guard.
- De-flaked `debug-capture-hook.test.js`: the debug file is written asynchronously, so the test now polls until the JSON parses (up to 5 s) instead of sleeping a fixed 50 ms — under full-suite load the old sleep could read a partial file.

#### [2.1.4-rc.6] - 2026-07-05

### Fixed — Deterministic voice-command names on any Matter controller

Voice assistants (Alexa, Siri, Google) resolve utterances by the **exact, unique device name**. On the reference production install (Homebridge 2.1.0, Matter-only child bridge, 109 endpoints) the rc.5 topology summary showed `metadataChanged=6` on *every* boot: the six cover/zone homonym pairs (Device 75, Device 11, Device 54, Device 69, Device 32, Device 70) were registered clean-name-first by the zone, then renamed *after* registration by the displaced-rename mechanism — leaving a window on every boot where **two devices carried the same name** and Alexa/Siri could cache/match the contact sensor instead of the cover ("il dispositivo non risponde"). Fixed by moving name resolution *before* registration:

- **Two-phase name resolution (new `matter-name-map.ts`, `matter-name-service.ts`, `matter-name-store.ts`, `matter-name-finalizer.ts`).** At `onInitialSyncComplete`, the final uuid → displayName map for the *whole* device set is computed in a single deterministic batch (priority: cover/light/thermostat/gate/scenario > zone/sensor; stable `device.id` tie-break; typed suffix ` - Sens.`/` - Tapp.`/…; uuid tag as last resort, lengthened until unique). Name slots are matched **case-insensitively** — by construction the map can never contain two equal voice names.
- **Persisted name-map.** The batch result is stored in `klares4-matter-names.json` (Homebridge storage path, same pattern as the thermostat fallback store) and reloaded at construction: from the second boot on, **every accessory registers with its final name from the very first `registerPlatformAccessories` call**, regardless of the order ZONES/MULTI_TYPES arrive in. The six homonym zones now register directly as `Finestra <X> - Sens.`; the cover owns `Finestra <X>` from the first instant, on every boot.
- **Targeted refresh only on real panel changes.** After each sync the computed map is diffed against what was actually registered (`registeredDisplayName`, tracked at register time): only genuine panel-side additions/renames trigger a refresh — implemented as a same-UUID unregister+register, the pattern already proven by the stale-endpoint recovery path (Homebridge 2's `matter.updatePlatformAccessories` drops live endpoints and is still never called; rooms/automations survive because the endpoint identity is UUID-derived). If the map is unchanged, the store is not rewritten.
- **Displaced-rename demoted to internal fallback.** `MatterAccessoryRegistry` no longer drains `consumePendingMatterRenames` after each register; the incremental `MatterNameRegistry` (seeded from the persisted map so it can never hand out an already-owned name) only covers devices not in the map yet — first boot ever, or devices newly added on the panel — and the batch finalize supersedes it at the next sync.
- **Acceptance criteria, verifiable from the summary log:** second consecutive boot with no panel changes → `metadataChanged=0`; regression-tested end-to-end on a two-boot simulation and on the real 109-endpoint dataset (`test/fixtures/klares4-devices.json`, extracted from the production debug capture): zero duplicate final names case-insensitively, `light_12` → "Room A", `light_11` → "Device 83", `cover_6` → "Device 32" — the exact names behind "accendi lo studio", "accendi la Device 83", "chiudi Device 32".

### Fixed — Name hygiene at the source (HAP + Matter)

- **`DES` normalised at parse time** (`normalizeDeviceName` in `device-state-projector.ts`, applied in output/zone/scenario parsers): trim + collapse of internal whitespace runs. The panel ships labels like `"Device 79 "` (trailing space) which used to leak into HAP names, MQTT payloads and the Matter sanitiser. Domain names are now born clean; `device.id`/UUIDs are never derived from names and are unchanged.
- **HAP displayNames sanitised against the HAP-NodeJS `checkName` rule** (new shared core `src/display-name.ts`, 64-char budget; the Matter sanitiser reuses the same allowlist with its 32-char budget so both ecosystems derive the *same words* from the same label). Applied at accessory creation, on cache restore and in all seven accessory handlers' `Name` characteristic — this removes the boot-time "invalid 'Name' characteristic" HAP warnings for `'Device 79 '`, `'Inserisci Finestre+Tapparelle'`, `'Device 29'` & co., cached accessories included.

### Added — Voice-namespace guard

- The end-of-sync summary now logs the complete final `name → uuid` table and emits an explicit **WARN for any pair of final names equal case-insensitively** — which cannot happen by construction; if it ever appears it is a name-map bug worth reporting.

### Added — Selective Matter exposure by type (`matterExposure`)

- New optional config object `matterExposure` (`zones`, `sensors`, `scenarios`, `lights`, `covers`, `gates`, `thermostats`, all default `true`, exposed in the Homebridge UI under "Esclusioni Dispositivi"). Disabling a type hides it from Matter controllers **only** — HAP accessories and the MQTT bridge keep publishing everything. Voice-first installations can drop the 39 contact zones from Alexa, halving the voice namespace and removing every near-collision.
- Endpoints of a disabled type are removed via the normal conservative prune: absent for 3 consecutive discovery cycles → clean unregister (rc.5 `MatterPruneTracker` discipline). This also covers endpoints that only exist in the Matter cache from a previous session (type disabled between restarts) via the cached-device snapshot now kept by `configureMatterAccessory`.
- The eligibility gate is enforced inside `MatterAccessoryRegistry` on **both** entry points (`addOrUpdateAccessory` *and* `updateAccessoryState`) — this also closes a pre-existing leak where a device excluded via `excludeZones`/`excludeOutputs`/… could sneak back into Matter through its first status update after boot.

### Documentation

- README: new **"Voice commands (Alexa / Siri / Google)"** section — how exact-name matching works, why the panel labels are already the source of truth, the one-time room setup required per controller (room membership is not conveyed via Matter), why custom aliases belong in the controller apps, and the `matterExposure` recommendation for voice-first installs.
- README: new **"Updating the plugin (important)"** runbook — always update in place; never uninstall/reinstall or regenerate the Matter child bridge (it regenerates the bridge username/Matter storage and destroys every pairing — production incident of 2026-07-05).

### Tests

- **215/215 passing (34 new).** New suites: `matter-name-map.test.js` (batch determinism across 35 discovery-order permutations, priority/tie-break rules, case-insensitive uniqueness, uuid-tag lengthening, and the full 109-endpoint production fixture with the six documented cover/zone collisions), `matter-name-service.test.js` (persistence round-trip, reload-before-finalize resolution in any order, no-rewrite on identical map, incremental fallback never colliding with seeded names, corrupt-store tolerance), `display-name.test.js` (HAP `checkName` compliance for all production offenders, 64 vs 32 char budgets). Extended: `matter-accessory-registry.test.js` (first-boot collision resolved at finalize; second boot registers final names immediately with `metadataChanged=0` and `unregistered=0` asserted from the cycle summary; order-flip boot; `matterExposure` gating on both entry points; 3-cycle prune of disabled types, cached-zombie case included), `websocket-device-state-projector.test.js` (DES trim/collapse at parse, id stability, typed placeholder fallback).

### Compatibility

- UUIDs, serial numbers and Matter part identities are unchanged for all existing devices; no changes to `_bridge`/commissioning/Matter storage; config keys are additive (`matterExposure`); MQTT topic shapes untouched. The only user-visible name changes are the removal of stray whitespace and, on installations with label collisions, suffixed *sensor* names now applied from the first registration instead of after it.

#### [2.1.4-rc.5] - 2026-07-05

### Fixed — Matter/Alexa topology churn (conservative discovery)

Addresses a production report where, after about a month running Matter, all accessories collapsed into the default room and Alexa periodically re-discovered devices. Root causes identified via a read-only diagnosis on the live install (69 Matter child-bridge reboots, repeated Alexa re-commissioning) and fixed conservatively, without touching UUIDs, storage, or requiring any Matter/Alexa reset:

- **Conservative stale pruning.** `pruneStaleAccessories` used to unregister any Matter accessory missing from a *single* discovery cycle — dangerous when a cycle is disturbed by a WS reconnect or a slow Klares4 response. A new `MatterPruneTracker` (`src/platform/matter-prune-tracker.ts`) now requires 3 consecutive missing cycles before a real unregister happens, resets the counter as soon as a device reappears, and never touches `cachedUUIDs`/fallback markers/echo-tracker state until a real unregister occurs.
- **Deterministic Matter name collisions.** Same-priority duplicate names (e.g. two covers both labelled "Device 75") used to resolve by "first arrival wins", which depends on WS/array ordering and boot timing — exactly the kind of churn that makes a controller perceive a renamed device. Same-priority ties are now broken by a stable comparison on `device.id`, so the same set of devices always converges to the same uuid → displayName mapping regardless of discovery order.
- **Stable output classification.** A partial/incomplete Klares4 re-poll (missing `CAT`/`MOD`) could previously flip an already-known output's classification (e.g. `gate_5` → `cover_5`), changing its `device.id`/UUID and making Matter/Alexa see a brand-new device for the same physical output. A new `OutputTypeMemory` (`src/websocket/device-state-projector.ts`) remembers the last confidently-classified type per Klares4 output id and keeps it stable across ambiguous updates.
- **Diagnostics.** Compact per-cycle Matter topology summary log (`discovered`/`registered`/`newlyRegistered`/`cachedRestore`/`metadataChanged`/`metadataUnchanged`/`missingCandidates`/`pruneSkipped`/`unregistered`, with a `(bootstrap)` marker on the first cycle) to make future incidents diagnosable from logs alone.

`registerPlatformAccessories` is still called on every boot for known accessories — this is required by the Matter runtime and is unchanged; the UUID is preserved so Apple Home rooms/automations and Matter fabrics are unaffected. 34 new tests added; full suite green.

#### [2.1.4-rc.4] - 2026-07-04

### Added
- **Telemetry**: Opt-out anonymous error reporting via Sentry to help track unhandled exceptions and bugs. Includes strict sanitization to never transmit sensitive data like PINs, IP addresses, URLs, custom device names, and configuration. Default is enabled (`telemetry: true`). Can be disabled via the plugin settings.

#### [2.1.4-rc.3] - 2026-05-24

### Changed — Matter name collisions: priority-based + abbreviated suffix

- **Higher-priority device types now win the clean name.** Real-world Lares4 discovery emits `ZONES` before `MULTI_TYPES`, which on 2.1.4-rc.2 meant the contact-sensor zone took the clean label and the controllable cover ended up tagged. The `MatterNameRegistry` now compares Lares4 device types on collision: cover, light, thermostat, gate and scenario (priority 10) displace zone and sensor (priority 1). When a higher-priority device arrives second, the registry hands the clean name to the newcomer and queues the displaced uuid in a *pending renames* map (`consumePendingMatterRenames`) that `MatterAccessoryRegistry` drains after each successful register, triggering a metadata refresh on the displaced accessory so the controller sees the new ` - Sens.` suffix. Net effect on the production log: `Device 69 (cover)` keeps the clean label, `Device 69 (zone)` becomes `Device 69 - Sens.`.
- **Abbreviated suffixes avoid mid-word truncation.** rc.2 produced labels like `Window Alpha Bedroo - Cover` (Device 80 chopped at 32-char limit). Suffix table is now: `zone/sensor → ' - Sens.'`, `cover → ' - Tapp.'`, `light → ' - Luce'`, `thermostat → ' - Term.'`, `scenario → ' - Scenario'`, `gate → ' - Cancello'`. Short enough that 27-char names fit without head truncation; pathological cases still truncate the head, never the suffix.
- **Anti-redundancy is now root-based.** Names like `Device 63` (which already starts with the cover type) no longer receive a redundant `- Tapp.` suffix when colliding with a peer; the registry falls back to the uuid-derived 4-char tag. Same for `Termostato …` → `Term.`, `Sensore …` → `Sens.`.

### Internal

- New export `consumePendingMatterRenames()` in `matter-device-mapper.ts` so `MatterAccessoryRegistry` can drain displaced-name events without reaching into the module-level singleton directly.
- `MatterNameRegistry` API additions: `consumePendingRenames()` returns and clears the pending-rename map. The `resolve` signature is unchanged.

#### [2.1.4-rc.2] - 2026-05-24

### Changed — Matter accessory name sanitisation (allowlist + typed collision suffix)

- **Sanitiser switched from blocklist to HomeKit-safe allowlist.** Output is now guaranteed to satisfy the HAP-NodeJS `checkName` rule (`^[\p{L}\p{N}][\p{L}\p{N}’ '.,-]*[\p{L}\p{N}’]$`) which is the strictest of the three controllers (Apple Home, Alexa, Google Home). Characters outside the set become spaces; leading/trailing punctuation is trimmed so the result always starts with a letter/digit and ends with a letter/digit/`’`. New regression test in `test/matter-name-sanitizer.test.js` runs the HAP regex against a sample of sanitised outputs.
- **Apostrophes preserved.** Both `'` and `’` are valid HomeKit characters and are now kept. Previously `Comando dell'Ingresso` was rewritten to `Comando dellIngresso`; it now stays `Comando dell'Ingresso`.
- **Collision suffix is now a human-readable Italian type tag.** When two accessories sanitise to the same string the first registered keeps the clean name; the second receives ` - <Tipo>` where `<Tipo>` is derived from the Lares4 device type: `Sensore` (zone, env. sensor), `Tapparella` (cover), `Luce` (light), `Termostato` (thermostat), `Scenario`, `Cancello` (gate). Example from a real install: previously `Device 69` (cover) + `Device 69` (zone) became `Device 69` + `Device 69 er_1`; now they become `Device 69` + `Device 69 - Sensore`.
- **Anti-redundancy guard.** If the sanitised name already mentions the device's own type as a whole word (e.g. two covers both called `Device 63`), the typed suffix is skipped and the legacy uuid-derived 4-char fallback is used to avoid `Device 63 - Tapparella`. The fallback is also used when the device type is unknown or when even the typed candidate collides.
- **API change (internal).** `MatterNameRegistry.resolve(uuid, sanitized, deviceType?)` now accepts an optional third argument. Callers that omit it (legacy / test convenience) get the uuid-derived fallback on collision, preserving the previous 2.1.3 behaviour.

### User-visible impact

Accessory `displayName`s visible in Apple Home, Alexa and Google Home will change for installations that previously hit collisions (e.g. cover + zone sharing the same Lares4 label). Custom names set by the user inside Apple Home / Alexa are preserved by those controllers and are not affected. UUIDs are unchanged, so HomeKit rooms and automations survive.

#### [2.1.4-rc.1] - 2026-05-24

### Fixed — Matter scenarios visible on Alexa (and re-tappable on Apple Home)

- **Scenarios were invisible in the Alexa app and stuck "ON" forever in Apple Home.** The momentary-switch mapper (used for `scenario` and `gate` devices) registered them with Matter device type `OnOffSwitch` (0x0103). Per Matter spec, `OnOffSwitch` is a **client** device — a wall switch that emits commands via binding, not a controllable endpoint. Apple Home is permissive and exposed it anyway, but Alexa follows the spec strictly and silently drops it from the device list. Combined with the existing momentary-trigger semantics (no real "off"), the result was: invisibility on Alexa, and on Apple Home the cluster `onOff` value latched to `true` so a second tap was suppressed by the controller before reaching the panel. Fix in [`src/platform/matter-device-mapper.ts`](src/platform/matter-device-mapper.ts): `mapMomentarySwitch` now uses `deviceTypes.OnOffOutlet` (Matter `OnOffPlugInUnit`, 0x010A) — a controllable server device that every ecosystem (Apple Home, Alexa, Google Home, SmartThings) imports as a tappable plug. The auto-off path (`scheduleMomentaryAutoOff`, default 500 ms, configurable via `scenarioAutoOffDelay`) continues to reset the cluster state so subsequent taps re-trigger the scenario. Visual effect: in Apple Home the scenario icon changes from "switch" to "outlet"; in Alexa scenarios now appear under **Plugs** and respond to voice commands ("Alexa, accendi Device 86"). Regression coverage: new test file [`test/matter-device-mapper.test.js`](test/matter-device-mapper.test.js) asserts the device type, the auto-off scheduling and that an auto-off rejection (e.g. endpoint not yet ready) is swallowed without surfacing to the controller.

## [2.1.3] - 2026-05-23

Stable release of the **`2.1.3-rc.1` … `2.1.3-rc.7`** cycle, validated on a
production Matter-only child bridge running Node 24 with 109 cached
accessories. Aggregates the fixes shipped over the seven release candidates
below; per-rc detail is preserved further down for archival reference.

### Fixed — Thermostat command routing (critical, verified in production)

- **`STATUS_TEMPERATURES` cross-pollination on swapped `(cfg, DOMUS sensor)` pairs.** On installations where two thermostats had numerically-swapped `(cfg-id, sensor-id)` pairs — in the reference setup *Device 80* `(cfg 3, sensor 4)` and *Room B* `(cfg 4, sensor 3)` — a setpoint or mode change on one was silently applied to the *other*: change Device 80 to 25 °C and Room B's `targetTemperature` ended up at 25 °C too. Root cause inchiodato sul debug capture `klares4-debug-2026-05-23T07-29-03.json`: the Lares4 panel keys `STATUS_TEMPERATURES` broadcasts by **DOMUS sensor id**, not by cfg/program id. The previous resolver compared the broadcast id against each thermostat's cfg ids, producing a numeric collision for swapped pairs. Fix: `resolveThermostatOutputIds` now matches strictly against each thermostat's **expected DOMUS sensor id** (via `state.thermostatToDomus`, falling back to `domusSensorIdByThermostatProgramId[programId]`). The degraded path is preserved but no longer mixes cfg ids into the candidate set. Secondary fix: removed a stale `thermostatCommandIdByOutputId[outputId] = entry.ID` write from `updateTemperatureStatuses` that was poisoning the command-resolver cache with a sensor id. Setups whose `cfg` and `sensor` ids coincide numerically (e.g. Room C `(1,1)`, Device 84 `(2,2)`, Room D `(5,5)`) were invisibly correct before and remain a no-op after.

- **Self-sustaining thermostat command loop on Matter (P0).** A single setpoint change from Apple Home on `thermostat_21` would trigger repeated `WRITE_CFG` commands at 2-3 s intervals until the user stopped Homebridge. Root cause: matter.js re-fires attribute-change handlers for the plugin's own pushes via `api.matter.updateAccessoryState`; the closure-scoped `ThermostatEchoGuard` from the abandoned rc.2 was recreated on every `refreshAccessoryMetadata`, losing state across re-mappings. Replaced with a plugin-scoped `MatterThermostatEchoTracker` (one per `MatterAccessoryRegistry`) that records every cluster value before pushing it, recognises matter.js re-fires as echoes, and covers `occupiedHeatingSetpoint`, `occupiedCoolingSetpoint` and `systemMode`. Added idempotency guards on all four thermostat handlers, swallowed WS errors so timeouts don't promote to matter.js retry loops, and made heating-only cooling-setpoint writes read/state-only.

### Fixed — Matter accessory registration

- **Matter accessory rejected for `nodeLabel` > 32 chars.** Matter spec §1.7.7.1 caps `BridgedDeviceBasicInformation.nodeLabel` at 32 characters but the plugin's sanitiser used 64. Real-world failure on `scenario_12 "Inserisci Tapparelle+Volumetrici"` (32 chars → ` e ` expansion → 34 chars → rejected with `String length of 34 is not within bounds`). `MAX_NAME_LENGTH` lowered to 32; the collision-suffix path was already bound to the same constant.
- **Stale matter.js endpoint after the 32-char fix.** Following the sanitisation tightening above, `scenario_12` still failed registration because matter.js had persisted the previous (over-limit) endpoint for that UUID. New register call succeeded but `getAccessoryState` kept reading the stale record. The recovery path now performs an `unregister` + `register` purge on the second recovery attempt — same UUID is reused so Apple Home rooms / automations survive — forcing matter.js to recreate the endpoint with the current sanitised displayName.

### Fixed — WebSocket / connectivity

- **Node.js 24 / OpenSSL 3 — `unsafe legacy renegotiation disabled` blocks connection to the Lares4 panel.** On Homebridge containers upgraded to Node 24 the WebSocket handshake to `wss://<panel>:443/KseniaWsock/` aborted at TLS level. The plugin already set `SSL_OP_LEGACY_SERVER_CONNECT` but the Lares4 firmware also triggers a TLS renegotiation later in the session that needs the separate `SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION` flag (OpenSSL 3 default-denies it). Both flags are now OR-ed together in the `https.Agent` `secureOptions`. No change to the `allowInsecureTls=false` strict path.

### Added — Diagnostics

- **Configurable debug-capture duration** (`debugCaptureDurationMs`, default 60_000 ms, clamp 10s..30min, exposed in the Homebridge UI under "Diagnostica & Debug"). The previous fixed 60 s window often closed before the user could reproduce the failing scenario from HomeKit, because on Matter-only setups Apple Home can take several minutes to re-sync the mesh after a child-bridge restart. Setting `debugCaptureDurationMs: 600000` (10 minutes) keeps the WebSocket trace alive long enough.
- **Register-request log line** now includes the sanitised displayName, its character count and the UUID: `register requested: <original> -> "<sanitised>" [Nch] (<type>, uuid=<uuid>)` — makes register failures diagnosable directly from the log.

### Observability — Apple Home / HomeKit side-effects

- As a beneficial side-effect of the `STATUS_TEMPERATURES` fix, the two channels that update a thermostat's `currentTemperature` and `humidity` (broadcast on `STATUS_BUS_HA_SENSORS` for DOMUS readings, and `STATUS_TEMPERATURES` for the thermostat program) now patch the *same* device coherently on swapped-pair installations. Before, they could fight each other and present "ballerine" temperature readings in HomeKit.

### Refactored

- Extracted the four Matter Thermostat handlers into `src/platform/matter-thermostat-handlers.ts` to keep `matter-device-mapper.ts` under the 350-line repo limit and co-locate the loop-prevention logic with the echo tracker.

### Tests

- **149/149 passing.** New regression suite for the production scenarios:
  - `STATUS_TEMPERATURES regression: crossed (cfg,sensor) pairs do NOT cross-pollinate` — reproduces the exact Device 80↔Room B setup in both directions.
  - `STATUS_TEMPERATURES.ID is the DOMUS sensor id (4 for Device 80), patch goes to thermostat_21` — rewritten from the old test that wrongly assumed `ID = cfg id`.
  - `matter-thermostat-echo-tracker.test.js` — unit coverage for the new echo tracker (per-UUID scoping, TTL expiry, record / consume / clear).
  - `matter-thermostat-echo-loop.test.js` — integration scenario for the matter.js handler-rewrite loop.
  - `matter-name-sanitizer.test.js` — regression on the two real-world failing scenario names and the long-name collision-suffix path under the 32-char limit.
  - `matter-accessory-registry.test.js` — stale-endpoint recovery (unregister-then-register) and register-request log format.

### Notes

- The KSA-cache pre-population path is unchanged: setups where the Lares4 panel rejects `READ PRG_THERMOSTATS` with `CMD_NOT_AVAILABLE` (firmware-dependent) still operate correctly because the plugin pre-loads `thermostatProgramById` / `thermostatProgramIdByOutputId` from the on-disk KSA cache (`klares4-ksa-cache.json`).
- Apple Home rooms and automations survive all the register/unregister cycles because the same accessory UUID is reused throughout.

---

### Per-RC archival history

#### [2.1.3-rc.7] - 2026-05-23

### Fixed (Thermostat, critical)

- **Cross-pollination between thermostats with "swapped" `(cfg, DOMUS sensor)` pairs.** In production: user changes setpoint on "Device 13" (output 21, cfg 3, DOMUS sensor 4) → "Device 49" (output 20, cfg 4, DOMUS sensor 3) also flips to the same setpoint and turns ON. Inverse on the other direction. Other thermostats (Room D cfg=5/sensor=5, Device 84 cfg=2/sensor=2) unaffected.

  **Root cause (verified via debug capture `klares4-debug-2026-05-23T07-29-03.json`)**: `STATUS_TEMPERATURES.ID` from the Lares4 panel is the **DOMUS sensor id**, NOT the cfg/program id. The previous `resolveThermostatOutputIds` (in `src/websocket-client/thermostat-status-updater.ts`) compared the broadcast `ID` against each thermostat's `manualCommandId` / `programCommandId` / `cachedCommandId` — all of which are **cfg ids**. When two thermostats had numerically-swapped pairs (cfg=3/sensor=4 vs cfg=4/sensor=3), the candidate list of one thermostat numerically matched the sensor id of the other, so the patch landed on the wrong device. Pairs where cfg and sensor coincide numerically (cfg=5/sensor=5, etc.) were spared by accident, which is why the bug was invisible on most installations.

  **Fix**: `resolveThermostatOutputIds` now computes each thermostat's **expected DOMUS sensor id** (from `state.thermostatToDomus`, with a fallback to `state.domusSensorIdByThermostatProgramId[programCommandId]`) and matches `STATUS_TEMPERATURES.ID` strictly against that. The degraded-mode path (no DOMUS mapping at all) is preserved but no longer mixes cfg ids into the candidate set.

  **Secondary fix**: removed a stale write `state.thermostatCommandIdByOutputId.set(outputId, entry.ID)` from `updateTemperatureStatuses`. That line was overwriting the cache used by the command resolver (`command-service.ts`) and config-sync path with a sensor id instead of a cfg id, poisoning subsequent WRITE_CFG routing decisions. Only `command-service.ts` and `thermostat-config-sync.ts` write that map now, and they always write the cfg id.

### Tests

- New regression test `STATUS_TEMPERATURES regression: crossed (cfg,sensor) pairs do NOT cross-pollinate` reproduces the exact Device 80↔Room B scenario and asserts that an `ID=4` broadcast patches only `thermostat_21` (Device 80, sensor 4), leaves `thermostat_20` (Room B, sensor 3) untouched, and vice-versa for `ID=3`.
- Updated `STATUS_TEMPERATURES.ID is the DOMUS sensor id ...` (renamed from the old `PRG_THERMOSTATS routes thermostat output 21 to cfg id 3 and sensor 4`) to feed the realistic `ID=sensor_id=4` payload instead of the unreal `ID=cfg_id=3` previously assumed.

### Notes

- Setups where, for every thermostat, the cfg id and the DOMUS sensor id are the same number (Room C, Device 84, Room D in our reference install) saw no symptom because the candidate set "by accident" contained the correct id. The fix is a no-op for those.

#### [2.1.3-rc.6] - 2026-05-23

### Added (Diagnostics)

- **`debugCaptureDurationMs` config option**: makes the boot-time debug capture duration configurable (default 60s, range 10s..30min, exposed in the Homebridge UI under "Diagnostica & Debug"). On Matter-only setups, Apple Home / Matter mesh can take several minutes to become responsive again after a child-bridge restart — the previous fixed 60s window often closed before the user could reproduce the failing scenario from HomeKit. Setting `debugCaptureDurationMs: 600000` (10 minutes) keeps the WebSocket trace alive long enough to capture a real user-triggered command after the mesh resync completes.

### Notes

- The debug capture itself does NOT cause accessories to disappear from Apple Home — the delay is the legitimate Matter mesh resync that follows every child-bridge restart (the Matter spec doesn't bound this on the controller side). Increasing the capture duration is the right knob.

#### [2.1.3-rc.5] - 2026-05-23

### Fixed (WebSocket, critical)

- **Node.js 24 / OpenSSL 3 — `unsafe legacy renegotiation disabled` blocks connection to Lares4 panel.** With Homebridge container upgraded to Node 24, the WebSocket handshake to `wss://<panel>:443/KseniaWsock/` failed at TLS level with `write EPROTO ... unsafe legacy renegotiation disabled (ssl/statem/extensions.c:893)`. The plugin already passed `SSL_OP_LEGACY_SERVER_CONNECT` but that flag only allows the initial handshake against panels missing RFC 5746; the renegotiation path required by the Lares4 firmware needs the separate `SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION` flag. The two flags are now OR-ed together in the `https.Agent` `secureOptions`, restoring connectivity on Node 20–24 without weakening the `allowInsecureTls=false` path.



### Fixed (Matter)

- **Stale matter.js endpoint after the 32-char nodeLabel fix.** After upgrading to 2.1.3-rc.3, `scenario_12 "Inserisci Tapparelle+Volumetrici"` still failed registration with `Matter accessory not queryable after registration` despite the name now being inside the 32-char limit. Root cause: matter.js had persisted the previous (over-limit) endpoint for that UUID on disk; the new `registerPlatformAccessories` call returned success but `getAccessoryState` kept reading the stale record, which the probe interpreted as a missing endpoint. The recovery path now performs an `unregisterPlatformAccessories` + `registerPlatformAccessories` purge on the second recovery attempt (same UUID — Apple Home rooms / automations survive), forcing matter.js to recreate the endpoint with the current sanitised displayName.

### Observability

- The `[Matter] register requested:` log line now includes the sanitised displayName, its character count, and the UUID. Makes register failures diagnosable directly from the log without re-deriving sanitiser output: `register requested: <original> -> "<sanitised>" [Nch] (<type>, uuid=<uuid>)`.

### Tests

- New regression in `matter-accessory-registry.test.js` covering the stale-endpoint recovery path (verifies the `unregister` precedes the second-attempt `register`, and that the UUID is preserved across all attempts).
- New test asserting the register-request log line includes the sanitised name, the char-count annotation, and the UUID.

#### [2.1.3-rc.3] - 2026-05-22

### Fixed (Matter, critical)

- **Bug 1 — Matter accessory rejected for `nodeLabel` > 32 chars.** Matter spec §1.7.7.1 caps `BridgedDeviceBasicInformation.nodeLabel` at 32 characters, but the plugin's name sanitiser used a 64-char limit. Real-world failure on `scenario_12 "Inserisci Tapparelle+Volumetrici"` (32 chars → ` e ` expansion → 34 chars → register rejected with `String length of 34 is not within bounds`). Lowered `MAX_NAME_LENGTH` to 32 in `matter-name-sanitizer.ts`; the collision-suffix path was already bound to the same constant. Regression tests cover the failing scenario and the collision case for long sanitised names.

- **Bug 2 P0 — Self-sustaining thermostat command loop.** A single setpoint change from HomeKit on `thermostat_21 (Device 13)` would trigger repeated WRITE_CFG commands on `thermostat_20 (Device 49)` and a multi-second autonomous loop that hammered the Lares4 centrale every 2-3 s until Homebridge was stopped. Root cause: matter.js re-fires attribute-change handlers for the plugin's own state pushes via `api.matter.updateAccessoryState`; the closure-scoped `ThermostatEchoGuard` from 2.1.3-rc.2 was insufficient because (a) it was recreated on every `refreshAccessoryMetadata`, losing state across re-mappings, (b) it never observed the registry-side pushes, only outgoing handler-side writes, and (c) it did not cover `systemMode`. Replaced with a **plugin-scoped `MatterThermostatEchoTracker`** (one instance per `MatterAccessoryRegistry`) that:
  - records every thermostat-cluster value the registry is about to push *before* `updateAccessoryState` (via a new `onBeforePush` hook in `MatterStateUpdateQueue`);
  - records the initial cluster values at `registerPlatformAccessories` time so the first matter.js reactor firings are also recognised as echoes;
  - is consulted by every Matter Thermostat handler (`occupiedHeatingSetpointChange`, `occupiedCoolingSetpointChange`, `systemModeChange`, `setpointRaiseLower`) before forwarding to the Lares4 WS client.
- Added **idempotency guard** to all thermostat handlers: a setpoint or systemMode change that already matches the device's current state short-circuits without sending WRITE_CFG. Prevents a degenerate restart of the loop if the echo tracker's TTL ever expires before the centrale broadcast lands.
- **Heating-only cooling-setpoint changes are now strictly read/state-only.** The Homebridge bundled Thermostat device type ships HEAT+COOL+AUTO+OCC features even for heating-only Lares4 zones; any controller-side write to `occupiedCoolingSetpoint` on a heating-only thermostat is dropped with a debug log instead of producing a WS command.
- **WS errors in Matter thermostat handlers are now swallowed.** A WRITE_CFG timeout used to bubble up to matter.js, which marked the reactor `Unhandled` and prompted controllers to retry — feeding the loop. The handler now logs at warn and returns; the echo tracker has already recorded the intent so the centrale echo (when it eventually lands) is still suppressed.

### Refactored

- Extracted the four Matter Thermostat handlers into `src/platform/matter-thermostat-handlers.ts` so the mapper module stays under the 350-line repo limit and the loop-prevention logic lives in one focused file alongside the new echo tracker.

### Tests

- `matter-thermostat-echo-tracker.test.js` — unit coverage for the new tracker (per-UUID scoping, TTL expiry, recordPushed / recordIntent / clear).
- `matter-thermostat-echo-loop.test.js` — integration scenario reproducing the production failure: internal push does not trigger a WS command; external command on `thermostat_21` never touches `thermostat_20`; heating-only cooling change is a no-op; idempotent change is a no-op; WS timeout in handler does not throw.
- `matter-name-sanitizer.test.js` — regression on the two real-world failing scenario names and on the long-name collision-suffix path under the 32-char limit.

## [2.1.2] - 2026-05-19

### Fixed (Matter, critical)

- Always call `registerPlatformAccessories` for every device on every boot, including UUIDs already loaded via `configureMatterAccessory`. The 2.1.0 "cache resume" optimisation (skip register for cached UUIDs) was wrong: the Homebridge MatterServer keeps a runtime accessory map populated only on register; the matter.js storage holds fabric/ACL/endpoint state but is not enough on its own. Without re-register at boot, every subsequent `updateAccessoryState` failed with `Accessory <UUID> not found or not registered` and Apple Home saw no devices. Apple Home rooms/automations are preserved because the same UUID is reused.

## [2.1.1] - 2026-05-19

### Fixed (Matter)

- Cache-resume path now trusts the Homebridge accessory cache instead of waiting up to 10s on `getAccessoryState` to confirm the Matter endpoint is ready. With ~80 cached accessories the matter.js endpoint restore is staggered and the previous behaviour produced spurious `[Matter] cache resume probe timed out … re-registering` warnings and slow boot. The new path does a brief best-effort probe (2s) but always marks the accessory `registered`; state updates still flow through the queue, which absorbs transient endpoint-not-ready errors. No effect on Apple Home rooms/associations (same UUID, no unregister).
- Bumped the default register-probe timeout from 10s to 30s for the genuine fresh-register path, so first-time accessory creation on slow systems doesn't fall back to recovery prematurely. Override via `KLARES4_MATTER_REGISTER_TIMEOUT_MS`.

## [2.1.0] - 2026-05-19

Stable release of the Homebridge 2.0 + Matter compatibility track. Aggregates
the work shipped over the `2.1.0-rc.0` … `2.1.0-rc.12` cycle, verified on a
production Matter-only child bridge (`hap=false`) with 81 Lares4 accessories
in Apple Home.

Highlights vs `2.0.1`:

- Homebridge 2.0 support with native Matter accessory registration via
  `api.matter.registerPlatformAccessories` (Thermostat, OnOffLight,
  DimmableLight, WindowCovering, TemperatureSensor, HumiditySensor,
  LightSensor, MotionSensor, ContactSensor, OnOffSwitch).
- Probe-based register settle: state updates are only pushed once
  `getAccessoryState` confirms the Matter endpoint is queryable.
- Cache-resume path: accessories already in the Homebridge cache are
  resumed without re-registering, so controllers (Apple Home, Google
  Home) no longer see `parts list change` notifications at every
  restart.
- Persistent thermostat fallback set (`klares4-matter-fallback.json`):
  thermostats that fall back to `TemperatureSensor` stay in sync with
  the Matter storage across restarts.
- Scenarios and gates are momentary `OnOffSwitch` devices with
  configurable auto-off (`scenarioAutoOffDelay`, default 500ms).
- Thermostat presetTypes workaround: `presetTypeFeatures` is now passed
  as a bitmap object, so matter.js 0.17 accepts the `Thermostat`
  cluster and thermostats register as full Thermostat devices in
  Apple Home (setpoint + mode control restored).

## [2.1.0-rc.12] - 2026-05-19

### Fixed (Matter)

- Thermostat registration: `presetTypeFeatures` now passed as a bitmap object `{ automatic: false, supportsNames: false }` instead of the number `0`, which matter.js 0.17 rejected with `Cannot manage number because it is not a bitmap object`. Thermostats now register as proper Matter `Thermostat` devices (not as `TemperatureSensor` fallback), restoring setpoint and mode control from Apple Home.
- Register/update race condition: replaced the fixed 2-second settle timer with a probe-based loop (`getAccessoryState` with exponential backoff, configurable via `KLARES4_MATTER_REGISTER_TIMEOUT_MS` / `KLARES4_MATTER_REGISTER_POLL_MS` / `KLARES4_MATTER_REGISTER_POLL_MAX_MS`). State updates are no longer pushed before the Matter endpoint is actually ready, eliminating `MatterDeviceError: Accessory ... not registered or missing endpoint` at startup.
- Scenarios stuck in `ON` state: scenarios now expose `OnOffSwitch` and auto-reset to off after a configurable delay (`scenarioAutoOffDelay`, default 500ms) so subsequent triggers work as expected.
- Gate handler asymmetry: gates now use `OnOffSwitch` with momentary semantics (single impulse + auto-off) instead of `OnOffOutlet` with dual toggle.
- Full re-registration on every restart: accessories already present in the Homebridge cache are now resumed via probe instead of re-registered, preventing controllers (Apple Home, Google Home) from seeing 81 spurious `parts list change` notifications.
- Fallback persistence: thermostats that fall back to `TemperatureSensor` are persisted to `klares4-matter-fallback.json` so the plugin and the Matter storage stay in sync across restarts (no more cluster mismatch between an endpoint stored as `TemperatureSensor` and the plugin still pushing to the `thermostat` cluster).
- 30-second state-update bootstrap delay reduced to 0 by default (env override still available); combined with probe-based settle, system temperature sensors now appear in Apple Home within seconds of startup.

## [2.0.1] - 2026-03-13

### Added

- KSA import pipeline (`ksaImport`) with deterministic derivation for thermostat command routing, Domus sensor mapping, room mapping, and optional custom names.
- Sanitized KSA runtime cache (`klares4-ksa-cache.json`) with whitelist-only structural metadata (no raw backup persistence).
- Bilingual technical documentation under `docs/en` and `docs/it` covering architecture, websocket behavior, Domus routing, config, and troubleshooting.
- CI/CD upgrade:
  - Node 20/22 CI validation matrix with strict type-check + tests + build artifact
  - npm publish workflow via GitHub Actions (tag/manual release path, provenance, and publish guards).

### Fixed

- Thermostat authoritative state alignment on Domus installations using `STATUS_TEMPERATURES` for realtime mode/setpoint/current state.
- Thermostat routing mismatch on systems where output IDs, Domus sensor IDs, and `CFG_THERMOSTATS.ID` are not numerically aligned.
- Startup synchronization robustness by preloading thermostat structural mapping from sanitized KSA cache when `PRG_THERMOSTATS` is not exposed by firmware.
- Degraded routing behavior now evaluates mapped Domus sensor candidates before raw output fallback in non-PRG environments.

## [2.0.1-beta2] - 2026-03-13

### Added

- New KSA import workflow in plugin config (`ksaImport`) to parse central backup metadata and derive deterministic routing data.
- Sanitized KSA cache persisted in Homebridge storage (`klares4-ksa-cache.json`) with thermostat/output/sensor/room mappings only (no raw backup persistence).
- Automatic derivation from KSA for:
  - `domusThermostat.manualCommandPairs` (`output -> CFG/STATUS thermostat ID`)
  - `domusThermostat.manualPairs` (`output -> Domus sensor`)
  - optional `roomMapping` and optional `customNames`.

### Fixed

- Runtime thermostat routing now preloads program mappings from KSA cache when realtime `PRG_THERMOSTATS` is unavailable on panel firmware.
- Degraded command resolver now evaluates mapped Domus sensor IDs before raw output fallback, improving compatibility in non-PRG environments.
- Initial websocket state can bootstrap thermostat program maps from cached KSA data to avoid startup desynchronization.

## [2.0.1-beta1] - 2026-03-13

### Fixed

- DOMUS thermostats now use `STATUS_TEMPERATURES` as the authoritative source for realtime mode, setpoint, current temperature and HVAC activity.
- DOMUS thermostat routing now uses `PRG_THERMOSTATS` over WSS to resolve the real relation between output, thermostat config ID and Domus sensor.
- Fixed swapped command routing on installations where `CFG_THERMOSTATS.ID` does not match the Domus sensor ID, including the real-world `Device 80`/`Room B` inversion.
- Removed the automatic legacy `WRITE/THERMOSTAT` fallback: thermostat writes now use only the observed `WRITE_CFG/CFG_THERMOSTATS` protocol.
- `STATUS_SYSTEM` fallback no longer overwrites mapped Domus/realtime thermostat data while fresher room or thermostat telemetry is available.

### Beta Focus

- Intended validation target: installations with Domus room sensors and mapped thermostats.

## [2.0.0] - 2026-03-08

### Added

- DOMUS thermostat command pipeline with automatic command-id resolution (`OUTPUT` -> `CFG_THERMOSTATS`) and cached config sync.
- Manual override support for command IDs via `domusThermostat.manualCommandPairs`.
- Runtime snapshot sync from `CFG_THERMOSTATS` to keep HomeKit thermostat mode/target aligned with panel state.

### Fixed

- DOMUS ID normalization across discovery (`BUS_HAS`) and realtime/status updates (`STATUS_BUS_HA_SENSORS`), including leading-zero cases (`01` -> `1`).
- Thermostat setpoint/mode regressions introduced in early RC builds by restoring the stable `beta.8` command flow.
- Config UI footer version and release metadata alignment.

## [2.0.0-beta.2] - 2026-03-07

### Fixed

- Output/scenario commands no longer wait for strict `CMD_USR_RES` ACK, preventing 8s command timeouts on centrales that apply command and emit only realtime state updates.
- Reconnect scheduler now avoids duplicate timer registration, removing duplicated "Scheduling reconnection..." log lines after connection failures.

## [2.0.0-beta.1] - 2026-03-07

### Changed

- Release version bump for npm publication continuity after `2.0.0-beta.0` version lock.

## [2.0.0-beta.0] - 2026-03-07

### Added

- **Modular architecture rollout** with facade compatibility preserved:
  - `platform/` split with dedicated lifecycle/discovery/registry/config services
  - `websocket-client/` split with transport/router/dispatcher/projector internals
  - `mqtt-bridge/` split with command execution and accessory indexing services
  - `debug-capture/` split with capture/analysis/file generation modules
- **Governance quality gates**:
  - `npm run check:max-lines` enforcing `src/**/*.ts <= 300` lines
  - `npm run verify` for strict TypeScript + tests + build
  - CI workflow for automated gate execution on push/PR
- **Release scripts**:
  - `npm run release:dry-run`
  - `npm run release:beta`

### Changed

- Internal architecture now follows explicit layered hierarchy:
  - `Communication -> Domain -> Infrastructure`
- `ARCHITECTURE.md` updated to document module responsibilities and flows.

### Compatibility

- No breaking changes to Homebridge runtime contract:
  - `PLATFORM_NAME` / `PLUGIN_NAME` unchanged
  - accessory UUID generation unchanged
  - config schema keys unchanged
  - MQTT topic/payload contract unchanged
  - public facades (`Lares4Platform`, `KseniaWebSocketClient`, `MqttBridge`, `DebugCaptureManager`) preserved

## [1.1.9-beta0] - 2026-03-07

### Added

- **Command response timeout control**: Added `commandTimeoutMs` configuration to tune write command ACK timeout.
- **Refactoring architecture modules** (internal, non-breaking):
  - `device-id` helpers for canonical ID parsing/building
  - `thermostat-mode` mapping helpers
  - `thermostat-state` compatibility adapter (status as canonical)
  - WebSocket internal components (`command-dispatcher`, `protocol-router`, `device-state-projector`, `ws-transport`)
  - MQTT internal helpers (`topic-parser`, `state-payload-mapper`)
  - Platform internal services (`accessory-registry`, `discovery-service`, `platform-lifecycle-service`)
- **Architecture documentation**: Added `ARCHITECTURE.md`.
- **Extended automated test suite**: Added characterization/contract tests for lifecycle helpers, WS command flow components, topic/payload contracts, thermostat mappings and ID utilities (`node --test`).

### Fixed

- **Thermostat discovery gap**: Outputs recognized as thermostats are now discovered and exposed correctly.
- **Login false-positive**: WebSocket `connect()` now resolves only after `LOGIN_RES=OK` with explicit login timeout.
- **Accessory cache drift**: Added stale accessory pruning after initial sync to remove ghost accessories.
- **Race conditions on commands**: Added per-device command queueing and command ACK waiting to avoid concurrent command overlap.
- **Runtime value validation**: Added numeric parsing/clamping guards before HomeKit characteristic updates to avoid `NaN`/out-of-range propagation.
- **Gate handling consistency**: Added `gate_` normalization in IDs and room mapping validation.
- **Shutdown cleanup**: Improved disconnect flow for WebSocket and MQTT bridge on Homebridge shutdown.
- **Debug capture safety**: Masked sensitive parsed payload data and restored WebSocket hooks reliably after capture.

### Security

- **TLS verification policy**: Certificate verification is strict by default; insecure TLS requires explicit `allowInsecureTls=true`.

## [1.1.8] - 2026-03-07

### Fixed

- **WebSocket session leak (firmware crash)**: Replaced `ws.terminate()` with graceful `ws.close(1001, 'Heartbeat timeout')` in `forceReconnect()`. The firmware now receives the WebSocket CLOSE frame and can properly release the session. Previously, abrupt TCP disconnects left "ghost" sessions accumulating on the firmware over weeks, eventually causing firmware lockup requiring full reset.
- **Double reconnect scheduling**: Added `isManualClose` flag to prevent the `close` event handler from calling `scheduleReconnect()` when the disconnect was intentional (from `forceReconnect()` or `disconnect()`). This fixes the broken exponential backoff caused by double-scheduling.
- **PIN exposed in logs**: Applied `maskSensitiveData()` to `sendMessage()` log output. The PIN was previously logged in plain text during the login message.
- **Cover movement simulation race condition**: `updateStatus()` no longer overwrites `currentPosition`/`targetPosition` while a local movement simulation interval is active. This prevents conflicting updates between the local simulation and real-time firmware messages.
- **Cover simulation not stopped on firmware stop**: The movement simulation interval is now cancelled when the firmware signals `state: 'stopped'` (e.g., user stops cover physically via Ksenia app).
- **Cover NaN stepTime in setInterval**: Added guard to detect `distance === 0` or invalid `stepTime` before starting the simulation interval, preventing `setInterval(fn, NaN)` which fires immediately and continuously.

### Changed

- Removed all emoji characters from log messages, documentation, and UI schema
- Version bumped from 1.1.7-beta2 to 1.1.8 (stable release)

## [1.1.7-beta2] - 2026-01-17

### Added

- **System Temperature Sensors**: New automatic sensors for system temperatures
  - Internal temperature sensor (`Temperatura Interna`) from central unit
  - External temperature sensor (`Temperatura Esterna`) from external probe (if available)
  - Sensors are created dynamically only when temperature data is available (not "NA")
  - Real-time updates via STATUS_SYSTEM messages
  - Follows the same pattern as BUS_HA sensors for consistency
  - Can be assigned to different rooms and used in HomeKit automations

### Improved

- Enhanced temperature handling with proper NA (not available) detection
- Type-safe implementation with updated interfaces for STATUS_SYSTEM data structure

## [1.1.7] - 2026-01-14

### Added

- **Comprehensive Debug Capture System**: New 60-second diagnostic tool
  - Captures ALL raw WebSocket messages (incoming and outgoing)
  - Multiple device snapshots every 10 seconds during capture
  - Complete message analysis by type and command
  - Automatic PIN masking for security
  - Clear on-screen instructions for users to test non-working entities
  - Generates complete JSON file with everything needed for support
  - File location printed in logs: `~/.homebridge/klares4-debug-*.json`

### Improved

- **Enhanced Config UI**: Better debug section with step-by-step instructions
  - Added helpful alerts explaining what to do during capture
  - Clear file location display in UI
  - Simplified user experience for generating debug files

## [1.1.6] - 2026-01-01

### Added

- **Verbosity System**: New `logLevel` configuration option with 3 levels
  - `0` (Minimal): Only errors and zone alarms - reduces log noise by ~95%
  - `1` (Normal): Standard operation logs, startup summary, commands (default)
  - `2` (Debug): Full verbose logging for troubleshooting

### Security

- **PIN Masking**: PIN codes are now masked in all log messages (`"PIN":"***"`)
- Raw JSON containing sensitive data no longer logged

### Improved

- **Exponential Backoff Reconnection**: WebSocket reconnection now uses exponential backoff with jitter

  - Initial delay doubles with each attempt (5s -> 10s -> 20s -> 40s -> max 60s)
  - +/-10% jitter prevents "thundering herd" when multiple clients reconnect
  - Reduces log spam and CPU usage during network outages by ~80%
  - Attempt counter resets on successful connection

- **Heartbeat PONG Timeout**: Added dead connection detection

  - System now verifies PONG response to heartbeat PING
  - If no PONG received within 2x heartbeat interval, forces reconnection
  - Detects "zombie" TCP connections (half-open sockets)
  - Reduces HomeKit "Accessory Not Responding" false positives

- **Cover Movement Simulation**: Fixed concurrent interval issue
  - Previous movement simulation is now cancelled when new command arrives
  - Prevents erratic position updates when user sends rapid commands
  - Eliminates potential memory leak from orphaned intervals

### Changed

- Sensor value updates now log only at DEBUG level (major noise reduction)
- Zone IDLE events log at NORMAL+ level, but ALARM events always visible
- System temperature updates log only at DEBUG level
- Backward compatible: `debug: true` still works (equals `logLevel: 2`)

### Technical

- Added `reconnectAttempts` counter and `maxReconnectDelay` configuration
- Added `heartbeatPending` and `lastPongReceived` tracking for PONG timeout
- Added `forceReconnect()` method for clean reconnection on timeout
- Added `moveInterval` property to `CoverAccessory` for proper cleanup

## [1.1.5] - 2025-12-28

### Added

- **MQTT Bridge**: Full MQTT integration for publishing states and receiving commands
- Room mapping for MQTT topics
- Bilingual documentation (English/Italian)

## [1.1.1-beta.6] - 2025-12-28

### Changed

- **Strict TypeScript Refactoring**: Complete codebase rewrite for strict type compliance
- Replaced all `any` types with proper interfaces and discriminated unions
- Added explicit return types to all functions and methods
- Implemented type guards for MQTT command validation
- Improved error handling: clean messages without stack traces in production logs
- Removed all emojis from source code, comments, and log messages

### Technical

- New discriminated union types for device status (`KseniaLight`, `KseniaCover`, etc.)
- `AccessoryHandler` union type for typed accessory management
- Raw API response interfaces (`KseniaOutputStatusRaw`, `KseniaSensorStatusRaw`, etc.)
- Type guard functions (`isMqttLightCommand`, `isMqttCoverCommand`, etc.)
- Removed duplicate `MqttConfig` definition

### Documentation

- Bilingual README (English/Italian)
- Removed all emojis from documentation files
- Updated code style to match strict TypeScript standards

## [1.1.1-beta.5] - 2025-09-18

### Fixed

- **MQTT Bridge**: Corrected light state publishing - fixed `light.on` to `light.status?.on` mapping
- Light states now correctly reflect actual on/off status in MQTT messages
- Resolved issue where lights always appeared as "off" in MQTT broker

### Added

- Dynamic device list generation for room mapping configuration
- Auto-generated `klares4-room-mapping-example.json` file with real device data
- Enhanced user interface for room mapping with actual device names and IDs
- Improved logging with full device IDs for easier configuration

### Changed

- Removed hardcoded device examples from config schema
- Enhanced device discovery summary with full device IDs
- Improved help documentation in Homebridge UI for room mapping

### Fixed

- Room mapping configuration now uses actual devices from user's Lares4 system

## [1.1.1-beta.1] - 2025-09-16

### Added

- **Room Mapping for MQTT**: New feature to organize devices by room in MQTT topics
- Room-based MQTT topic structure: `homebridge/{room}/{type}/{id}/state`
- Configurable room mapping through Homebridge UI
- Backward compatibility for existing MQTT topic format
- Support for both old and new command topic formats

### Changed

- MQTT topic structure can now include room names when room mapping is enabled
- Enhanced config schema with new "Room Mapping MQTT" section
- Improved MQTT bridge to support dynamic room assignment

### Technical

- Added `getRoomForDevice()` function to MQTT bridge
- Enhanced TypeScript types for room mapping configuration
- Updated subscription logic to handle multiple topic formats
- Maintained full backward compatibility

## [1.1.1-beta.0] - 2025-09-16

### Added

- Initial MQTT bridge functionality
- Device state publishing to MQTT topics
- MQTT command reception for device control
- Comprehensive device discovery and caching

### Changed

- Enhanced plugin architecture for better extensibility
- Improved device management and exclusion system

### Fixed

- Various stability improvements
- Enhanced error handling

## [1.1.0] - 2025-09-10

### Added

- Complete plugin rewrite for Ksenia Lares4 systems
- Support for multiple device types:
  - Security zones (contact sensors)
  - Lights with on/off control
  - Window coverings with position control
  - Thermostats with temperature and mode control
  - Environmental sensors (temperature, humidity, light)
  - Scenario automation triggers
- Real-time WebSocket communication with Lares4 system
- Configurable device exclusion system
- Custom device naming support
- Comprehensive Homebridge UI configuration interface

### Technical

- Modern TypeScript implementation
- Robust WebSocket client with auto-reconnection
- Modular accessory architecture
- Comprehensive logging and debugging support
- Device state caching and persistence

---

## Version History Summary

- **2.3.x**: fail-closed exposure, no telemetry, reliable commands and connection, native Matter thermostats, MQTT availability and `mqtt.commands`, validated configuration, bilingual documentation.
- **2.2.x**: security and compliance hardening (PIN masking, login guard, partial-arm scenarios hidden), Matter stability on Homebridge 2.4, Node 22.12 or later.
- **2.1.x**: Matter name determinism, topology stability, thermostat routing, selective Matter exposure.
- **2.0.x**: Matter support through Homebridge 2.x, modular architecture, strict TypeScript.
- **1.1.x**: MQTT bridge, room mapping, complete rewrite for Lares4.
- **1.0.x and earlier**: legacy versions, no longer supported.

## Migration Guide

### From 2.2.x to 2.3.0

- Read [Upgrading from 2.2.x](#upgrading-from-22x-read-first) at the top of `[Unreleased]`: hidden outputs and scenarios and how to expose them again, new Thermostat accessories on Matter, the removed `telemetry` setting, the new `<prefix>/status` topic and its ACL line.
- Values of the wrong type in `config.json` are now ignored with a warning; check the log at the first start.
- No change to UUIDs, config keys of existing devices or the shape of existing MQTT topics, except devices whose names collide.

### From 2.1.x to 2.2.0

- See [Upgrading from 2.1.x](#upgrading-from-21x-read-first) under `[2.2.0]`: Node 22.12 or later, partial-arm scenarios hidden by default, `customNames` as a list, a KSA import no longer enables `roomMapping`.

### From 2.0.x to 2.2.0

- Update in place and read the entries of 2.1.x and 2.2.0 in between; never reinstall the plugin or regenerate the Matter child bridge.

### From 1.1.1-beta.5 to 1.1.1-beta.6

- No configuration changes required. The codebase was refactored for strict TypeScript compliance and all functionality remains the same.

### From 1.1.1-beta.0 to 1.1.1-beta.1 and later

- Room mapping is optional and disabled by default. Existing MQTT configurations continue to work unchanged. To use room mapping, enable it in the "Room Mapping MQTT" section.

### From 1.0.x to 1.1.0 and later

- Complete reconfiguration required: new device discovery process and enhanced configuration options in the Homebridge UI.

## Support

For issues, feature requests, or questions:

- GitHub Issues: https://github.com/paolo-trivi/homebridge-plugin-klares4/issues
- Documentation: Check README.md for detailed setup instructions

[Unreleased]: https://github.com/paolo-trivi/homebridge-plugin-klares4/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.2.0
[2.2.0-rc.4]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.2.0-rc.4
[2.2.0-rc.3]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.2.0-rc.3
[2.2.0-rc.2]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.2.0-rc.2
[2.2.0-rc.1]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.2.0-rc.1
[2.1.5-rc.2]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.1.5-rc.2
[2.1.4]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.1.4
[2.1.3]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.1.3
[2.1.2]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.1.2
[2.1.1]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.1.1
[2.1.0]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.1.0
[2.1.0-rc.12]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.1.0-rc.12
[2.0.1]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.0.1
[2.0.0]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.0.0
[2.0.0-beta.2]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.0.0-beta.2
[2.0.0-beta.1]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.0.0-beta.1
[2.0.0-beta.0]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.0.0-beta.0
[1.1.8]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v1.1.8
[1.1.7-beta2]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v1.1.7-beta2
[1.1.6]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v1.1.6
[1.1.5]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v1.1.5
[1.1.1-beta.5]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v1.1.1-beta.5
[1.1.1-beta.1]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v1.1.1-beta.1
[1.1.1-beta.0]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v1.1.1-beta.0
[1.1.0]: https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v1.1.0
