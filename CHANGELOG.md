# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.4-rc.3] - 2026-05-24

### Changed — Matter name collisions: priority-based + abbreviated suffix

- **Higher-priority device types now win the clean name.** Real-world Lares4 discovery emits `ZONES` before `MULTI_TYPES`, which on 2.1.4-rc.2 meant the contact-sensor zone took the clean label and the controllable cover ended up tagged. The `MatterNameRegistry` now compares Lares4 device types on collision: cover, light, thermostat, gate and scenario (priority 10) displace zone and sensor (priority 1). When a higher-priority device arrives second, the registry hands the clean name to the newcomer and queues the displaced uuid in a *pending renames* map (`consumePendingMatterRenames`) that `MatterAccessoryRegistry` drains after each successful register, triggering a metadata refresh on the displaced accessory so the controller sees the new ` - Sens.` suffix. Net effect on the production log: `Finestra Cucina (cover)` keeps the clean label, `Finestra Cucina (zone)` becomes `Finestra Cucina - Sens.`.
- **Abbreviated suffixes avoid mid-word truncation.** rc.2 produced labels like `Finestra Matrimonia - Tapparella` (Matrimoniale chopped at 32-char limit). Suffix table is now: `zone/sensor → ' - Sens.'`, `cover → ' - Tapp.'`, `light → ' - Luce'`, `thermostat → ' - Term.'`, `scenario → ' - Scenario'`, `gate → ' - Cancello'`. Short enough that 27-char names fit without head truncation; pathological cases still truncate the head, never the suffix.
- **Anti-redundancy is now root-based.** Names like `Tapparella Studio` (which already starts with the cover type) no longer receive a redundant `- Tapp.` suffix when colliding with a peer; the registry falls back to the uuid-derived 4-char tag. Same for `Termostato …` → `Term.`, `Sensore …` → `Sens.`.

### Internal

- New export `consumePendingMatterRenames()` in `matter-device-mapper.ts` so `MatterAccessoryRegistry` can drain displaced-name events without reaching into the module-level singleton directly.
- `MatterNameRegistry` API additions: `consumePendingRenames()` returns and clears the pending-rename map. The `resolve` signature is unchanged.

## [2.1.4-rc.2] - 2026-05-24

### Changed — Matter accessory name sanitisation (allowlist + typed collision suffix)

- **Sanitiser switched from blocklist to HomeKit-safe allowlist.** Output is now guaranteed to satisfy the HAP-NodeJS `checkName` rule (`^[\p{L}\p{N}][\p{L}\p{N}’ '.,-]*[\p{L}\p{N}’]$`) which is the strictest of the three controllers (Apple Home, Alexa, Google Home). Characters outside the set become spaces; leading/trailing punctuation is trimmed so the result always starts with a letter/digit and ends with a letter/digit/`’`. New regression test in `test/matter-name-sanitizer.test.js` runs the HAP regex against a sample of sanitised outputs.
- **Apostrophes preserved.** Both `'` and `’` are valid HomeKit characters and are now kept. Previously `Comando dell'Ingresso` was rewritten to `Comando dellIngresso`; it now stays `Comando dell'Ingresso`.
- **Collision suffix is now a human-readable Italian type tag.** When two accessories sanitise to the same string the first registered keeps the clean name; the second receives ` - <Tipo>` where `<Tipo>` is derived from the Lares4 device type: `Sensore` (zone, env. sensor), `Tapparella` (cover), `Luce` (light), `Termostato` (thermostat), `Scenario`, `Cancello` (gate). Example from a real install: previously `Finestra Cucina` (cover) + `Finestra Cucina` (zone) became `Finestra Cucina` + `Finestra Cucina er_1`; now they become `Finestra Cucina` + `Finestra Cucina - Sensore`.
- **Anti-redundancy guard.** If the sanitised name already mentions the device's own type as a whole word (e.g. two covers both called `Tapparella Studio`), the typed suffix is skipped and the legacy uuid-derived 4-char fallback is used to avoid `Tapparella Studio - Tapparella`. The fallback is also used when the device type is unknown or when even the typed candidate collides.
- **API change (internal).** `MatterNameRegistry.resolve(uuid, sanitized, deviceType?)` now accepts an optional third argument. Callers that omit it (legacy / test convenience) get the uuid-derived fallback on collision, preserving the previous 2.1.3 behaviour.

### User-visible impact

Accessory `displayName`s visible in Apple Home, Alexa and Google Home will change for installations that previously hit collisions (e.g. cover + zone sharing the same Lares4 label). Custom names set by the user inside Apple Home / Alexa are preserved by those controllers and are not affected. UUIDs are unchanged, so HomeKit rooms and automations survive.

## [2.1.4-rc.1] - 2026-05-24

### Fixed — Matter scenarios visible on Alexa (and re-tappable on Apple Home)

- **Scenarios were invisible in the Alexa app and stuck "ON" forever in Apple Home.** The momentary-switch mapper (used for `scenario` and `gate` devices) registered them with Matter device type `OnOffSwitch` (0x0103). Per Matter spec, `OnOffSwitch` is a **client** device — a wall switch that emits commands via binding, not a controllable endpoint. Apple Home is permissive and exposed it anyway, but Alexa follows the spec strictly and silently drops it from the device list. Combined with the existing momentary-trigger semantics (no real "off"), the result was: invisibility on Alexa, and on Apple Home the cluster `onOff` value latched to `true` so a second tap was suppressed by the controller before reaching the panel. Fix in [`src/platform/matter-device-mapper.ts`](src/platform/matter-device-mapper.ts): `mapMomentarySwitch` now uses `deviceTypes.OnOffOutlet` (Matter `OnOffPlugInUnit`, 0x010A) — a controllable server device that every ecosystem (Apple Home, Alexa, Google Home, SmartThings) imports as a tappable plug. The auto-off path (`scheduleMomentaryAutoOff`, default 500 ms, configurable via `scenarioAutoOffDelay`) continues to reset the cluster state so subsequent taps re-trigger the scenario. Visual effect: in Apple Home the scenario icon changes from "switch" to "outlet"; in Alexa scenarios now appear under **Plugs** and respond to voice commands ("Alexa, accendi Mood Cena"). Regression coverage: new test file [`test/matter-device-mapper.test.js`](test/matter-device-mapper.test.js) asserts the device type, the auto-off scheduling and that an auto-off rejection (e.g. endpoint not yet ready) is swallowed without surfacing to the controller.

## [2.1.3] - 2026-05-23

Stable release of the **`2.1.3-rc.1` … `2.1.3-rc.7`** cycle, validated on a
production Matter-only child bridge running Node 24 with 109 cached
accessories. Aggregates the fixes shipped over the seven release candidates
below; per-rc detail is preserved further down for archival reference.

### Fixed — Thermostat command routing (critical, verified in production)

- **`STATUS_TEMPERATURES` cross-pollination on swapped `(cfg, DOMUS sensor)` pairs.** On installations where two thermostats had numerically-swapped `(cfg-id, sensor-id)` pairs — in the reference setup *Matrimoniale* `(cfg 3, sensor 4)` and *Bagno* `(cfg 4, sensor 3)` — a setpoint or mode change on one was silently applied to the *other*: change Matrimoniale to 25 °C and Bagno's `targetTemperature` ended up at 25 °C too. Root cause inchiodato sul debug capture `klares4-debug-2026-05-23T07-29-03.json`: the Lares4 panel keys `STATUS_TEMPERATURES` broadcasts by **DOMUS sensor id**, not by cfg/program id. The previous resolver compared the broadcast id against each thermostat's cfg ids, producing a numeric collision for swapped pairs. Fix: `resolveThermostatOutputIds` now matches strictly against each thermostat's **expected DOMUS sensor id** (via `state.thermostatToDomus`, falling back to `domusSensorIdByThermostatProgramId[programId]`). The degraded path is preserved but no longer mixes cfg ids into the candidate set. Secondary fix: removed a stale `thermostatCommandIdByOutputId[outputId] = entry.ID` write from `updateTemperatureStatuses` that was poisoning the command-resolver cache with a sensor id. Setups whose `cfg` and `sensor` ids coincide numerically (e.g. Sala `(1,1)`, Cameretta `(2,2)`, Studio `(5,5)`) were invisibly correct before and remain a no-op after.

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
  - `STATUS_TEMPERATURES regression: crossed (cfg,sensor) pairs do NOT cross-pollinate` — reproduces the exact Matrimoniale↔Bagno setup in both directions.
  - `STATUS_TEMPERATURES.ID is the DOMUS sensor id (4 for Matrimoniale), patch goes to thermostat_21` — rewritten from the old test that wrongly assumed `ID = cfg id`.
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

- **Cross-pollination between thermostats with "swapped" `(cfg, DOMUS sensor)` pairs.** In production: user changes setpoint on "Riscaldamento Matrimoniale" (output 21, cfg 3, DOMUS sensor 4) → "Riscaldamento Bagno" (output 20, cfg 4, DOMUS sensor 3) also flips to the same setpoint and turns ON. Inverse on the other direction. Other thermostats (Studio cfg=5/sensor=5, Cameretta cfg=2/sensor=2) unaffected.

  **Root cause (verified via debug capture `klares4-debug-2026-05-23T07-29-03.json`)**: `STATUS_TEMPERATURES.ID` from the Lares4 panel is the **DOMUS sensor id**, NOT the cfg/program id. The previous `resolveThermostatOutputIds` (in `src/websocket-client/thermostat-status-updater.ts`) compared the broadcast `ID` against each thermostat's `manualCommandId` / `programCommandId` / `cachedCommandId` — all of which are **cfg ids**. When two thermostats had numerically-swapped pairs (cfg=3/sensor=4 vs cfg=4/sensor=3), the candidate list of one thermostat numerically matched the sensor id of the other, so the patch landed on the wrong device. Pairs where cfg and sensor coincide numerically (cfg=5/sensor=5, etc.) were spared by accident, which is why the bug was invisible on most installations.

  **Fix**: `resolveThermostatOutputIds` now computes each thermostat's **expected DOMUS sensor id** (from `state.thermostatToDomus`, with a fallback to `state.domusSensorIdByThermostatProgramId[programCommandId]`) and matches `STATUS_TEMPERATURES.ID` strictly against that. The degraded-mode path (no DOMUS mapping at all) is preserved but no longer mixes cfg ids into the candidate set.

  **Secondary fix**: removed a stale write `state.thermostatCommandIdByOutputId.set(outputId, entry.ID)` from `updateTemperatureStatuses`. That line was overwriting the cache used by the command resolver (`command-service.ts`) and config-sync path with a sensor id instead of a cfg id, poisoning subsequent WRITE_CFG routing decisions. Only `command-service.ts` and `thermostat-config-sync.ts` write that map now, and they always write the cfg id.

### Tests

- New regression test `STATUS_TEMPERATURES regression: crossed (cfg,sensor) pairs do NOT cross-pollinate` reproduces the exact Matrimoniale↔Bagno scenario and asserts that an `ID=4` broadcast patches only `thermostat_21` (Matrimoniale, sensor 4), leaves `thermostat_20` (Bagno, sensor 3) untouched, and vice-versa for `ID=3`.
- Updated `STATUS_TEMPERATURES.ID is the DOMUS sensor id ...` (renamed from the old `PRG_THERMOSTATS routes thermostat output 21 to cfg id 3 and sensor 4`) to feed the realistic `ID=sensor_id=4` payload instead of the unreal `ID=cfg_id=3` previously assumed.

### Notes

- Setups where, for every thermostat, the cfg id and the DOMUS sensor id are the same number (Sala, Cameretta, Studio in our reference install) saw no symptom because the candidate set "by accident" contained the correct id. The fix is a no-op for those.

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

- **Bug 2 P0 — Self-sustaining thermostat command loop.** A single setpoint change from HomeKit on `thermostat_21 (Riscaldamento Matrimoniale)` would trigger repeated WRITE_CFG commands on `thermostat_20 (Riscaldamento Bagno)` and a multi-second autonomous loop that hammered the Lares4 centrale every 2-3 s until Homebridge was stopped. Root cause: matter.js re-fires attribute-change handlers for the plugin's own state pushes via `api.matter.updateAccessoryState`; the closure-scoped `ThermostatEchoGuard` from 2.1.3-rc.2 was insufficient because (a) it was recreated on every `refreshAccessoryMetadata`, losing state across re-mappings, (b) it never observed the registry-side pushes, only outgoing handler-side writes, and (c) it did not cover `systemMode`. Replaced with a **plugin-scoped `MatterThermostatEchoTracker`** (one instance per `MatterAccessoryRegistry`) that:
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
- Fixed swapped command routing on installations where `CFG_THERMOSTATS.ID` does not match the Domus sensor ID, including the real-world `Matrimoniale`/`Bagno` inversion.
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

- **1.1.1-beta.x**: MQTT integration and room mapping features
- **1.1.0**: Complete plugin rewrite with full Lares4 integration
- **1.0.x**: Legacy versions (deprecated)

## Migration Guide

### From 1.1.1-beta.5 to 1.1.1-beta.6

- No configuration changes required
- Codebase refactored for strict TypeScript compliance
- All functionality remains the same

### From 1.1.1-beta.0 to 1.1.1-beta.1+

- Room mapping is optional and disabled by default
- Existing MQTT configurations continue to work unchanged
- To use room mapping, enable it in the new "Room Mapping MQTT" section

### From 1.0.x to 1.1.0+

- Complete reconfiguration required
- New device discovery process
- Enhanced configuration options through Homebridge UI
- Improved stability and performance

## Support

For issues, feature requests, or questions:

- GitHub Issues: https://github.com/paolo-trivi/homebridge-plugin-klares4/issues
- Documentation: Check README.md for detailed setup instructions
