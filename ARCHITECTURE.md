# Architecture Overview

This document describes the structure of the plugin as of `2.3.0`: the layers, the module that owns each responsibility, the boundaries of truth and the exposure policy. Behavior for users is in the [README](README.md) and in [`docs/`](docs/README.md).

## Design Goals

- Preserve runtime and configuration compatibility with existing Homebridge installations (aliases, config keys, MQTT topic shapes, accessory UUIDs, persisted data).
- Keep each class small and each decision in one place.
- Make protocol, mapping and lifecycle behaviors testable without a panel or a broker.
- Fail closed: what the plugin does not recognize is not exposed and not commandable.

## Layered Hierarchy

### 1) Communication Layer

**WebSocket** — public facade `KseniaWebSocketClient` (`websocket-client/index.ts`).

- Connection: `connection-service.ts` (session, login, sync watchdog), `connection-setup.ts` (URL, TLS agent, `maxPayload`), `heartbeat-monitor.ts` (ping/pong), `reconnect-scheduler.ts` (backoff with ceiling and jitter), `login-rejection-guard.ts` and `login-response-handler.ts` (the 3-failure guard, one retry per hour afterwards), `tls-error-hint.ts`.
- Inbound frames: `inbound-frame.ts` (JSON, shape and CRC check), `message-service.ts` (routing, isolation of one bad entry), `sync-read-policy.ts` (what a refused read means for the sync), `crc16.ts`.
- Discovery: `discovery-read-handler.ts` (zones, outputs, scenarios, DOMUS sensors), `scenario-discovery.ts`, `discovered-device.ts` (discovery rounds and what survives a re-read), `device-parsers.ts` (scenario exposure rules, parsers), `exposure-report.ts` (hidden devices and the single startup warning).
- Status: `status-updater.ts`, `zone-status-reader.ts`, `system-temperature-updater.ts`, `thermostat-status-updater.ts`, `output-state-matchers.ts`.
- Commands: `command-service.ts` (lights, covers, gates, scenarios; refuses anything that is not a discovered device of that kind), `command-sender.ts` (framing, ID, CRC, wait for the answer), `command-outcome.ts`.
- Thermostats: `thermostat-read-handler.ts` (outputs, `CFG_THERMOSTATS`, `PRG_THERMOSTATS`), `thermostat-config-sync.ts`, `thermostat-cfg-freshness.ts` (`PRG_CHECK` counter, `NM_CHANGES`), `thermostat-command-service.ts` (validation and routing) → `thermostat-command-id-resolver.ts` (manual pair → program → verified guess, the guess judged by `thermostat-degraded-guess.ts`: accepted only when it is the one coherent candidate, remembered only after a discriminating match) → `thermostat-write-batcher.ts` (serialization per configuration ID, merging) → `thermostat-write-executor.ts` (re-read, partial payload, acknowledgement) with `thermostat-write-payload.ts` and `thermostat-command-payload.ts`; `domus-thermostat-mapper.ts` and `domus-thermostat-mapping-runtime.ts` (sensor mapping); `thermostat-sequence.ts` (the monotonic order of thermostat events: two events in the same millisecond still have a first and a second).
- Shared: `state.ts` (client state), `bounded-map.ts`, `types.ts`.

`websocket/` holds the protocol internals:

- `command-dispatcher.ts` (pending IDs, correlation, positive-result validation) with `device-command-queue.ts` (per-device queue: `serial`, `latest-wins`, `reject-while-busy`, deadline, depth cap), `protocol-result.ts` (the one normalization of `RESULT`), `output-command-confirmation.ts` (state confirmation as a transition after registration).
- `protocol-router.ts` (routing by `CMD`/`PAYLOAD_TYPE`), `ws-transport.ts` (send, ping, close).
- `device-state-projector.ts` (payload parsing; re-exports) and `output-classifier.ts` (`determineOutputType`, `resolveOutputExposure`: the output half of the exposure policy).

**MQTT** — public facade `MqttBridge` (`mqtt-bridge/index.ts`).

- `broker-session.ts` (connection, retry backoff, last will on `<prefix>/status`), `last-will-policy.ts` (whether a CONNECT carries the last will: set aside only when the broker refuses the CONNECT with it as not authorized and accepts the next one without it, then retried periodically), `state-publisher.ts` and `state-topic-registry.ts` (state topics, collisions → ID topics), `command-intake.ts` (retained, duplicate and size filter), `command-executor.ts` (validation, one running and one waiting command per device), `accessory-index-service.ts` (ID, slug and room lookup, exclusions), `room-resolver.ts`, `command-failure.ts`, `throttled-log.ts`.
- `mqtt/`: `topic-parser.ts` (topic parsing and slugs), `state-payload-mapper.ts` (stable payloads), `broker-url.ts` (URL validation and masking), `log-text.ts`.
- `mqtt.commands: false` removes the command subscription entirely.

**Diagnostics capture** — public facade `DebugCaptureManager` (`debug-capture/index.ts`): `raw-message-capture.ts`, `redaction.ts` (key-based redaction at any depth, text fallback), `capture-buffer.ts` (caps: 5,000 frames, 2 MiB; each frame stored once, as text), `analysis.ts`, `file-generator.ts` (the file is written with mode `0600`).

### 2) Domain Layer

- `device-id.ts`: canonical device IDs, the single source of truth; `device-slug.ts`: the slug of a device or room name, shared by the MQTT topics and the KSA room derivation.
- `thermostat-mode.ts`, `thermostat-state.ts`, `thermostat-role.ts`: Ksenia/domain/HomeKit mode mapping, canonical thermostat state, the heating/cooling role of an output.
- `device-observation.ts`: what has and has not been observed yet (a device the panel never reported is "not observed", not zero).
- `display-name.ts`: name cleaning shared by HAP and Matter.
- `errors.ts`: the error types a caller tells apart with `instanceof` (retryable, validation refusal, refused by the panel; the queue rejection extends retryable, the thermostat routing refusal extends validation) and `toErrorMessage`, the one conversion of anything thrown to text; `isolation.ts`: one failure never takes the rest of a batch with it.
- `ksa/`: `parser.ts` (the `.ksa` backup is untrusted input: numeric IDs only, names cut, 32 MB cap), `derive.ts` (thermostat, sensor, room and name derivation), `cache-service.ts` (sanitized cache).
- `log-levels.ts`: log level definitions and `maskSensitiveData`, the PIN masking applied to every frame that is logged; `leveled-logger.ts`: Homebridge's logger held to the configured `logLevel` (the platform wraps it once, every service logs through it: 0 drops info lines, 2 writes the plugin's debug lines without Homebridge's `-D`); `secret-keys.ts`: the key families that hold a secret, shared by the log mask and the debug file redaction so the two cannot drift apart; `plugin-version.ts`: the plugin version, and the suffix-free form that HAP and Matter accept as firmware revision; `settings.ts`: plugin name and alias constants.

### 3) Infrastructure Layer

Homebridge orchestration — public facade `Lares4Platform` (`platform/index.ts`).

- **Configuration:** `runtime-config.ts` (`resolveRuntimeConfig`) is the only place the raw Homebridge config is interpreted; `runtime-config-limits.ts` holds the numeric limits table (a test compares it with `config.schema.json`); `config-values.ts` the readers and the grouped warning collector; `runtime-config-sections.ts`, `exclusion-lists.ts`, `custom-names-config.ts`, `matter-override-config.ts`, `exposure-opt-in-config.ts` the per-section normalization; `override-reconciliation.ts` the end-of-first-sync report. `Lares4Config` is the validated view (`platform.config`); `RawLares4Config` is the input type.
- **Wiring:** `client-options.ts` (client creation and options), `debug-capture-start.ts`, `device-event-router.ts` (per device: exclusion, name derivation, HAP limit; HomeKit, Matter and MQTT are handled independently), `sync-lifecycle.ts` (the synchronization lifecycle: each login opens the HAP and Matter discovery cycles; at its end the HAP prune, then a single-flight Matter finalize and prune; panel connection events drive Matter reachability and the MQTT status), `platform-lifecycle-service.ts` (timers, shutdown).
- **HomeKit:** `accessory-registry.ts` (cache, add, update, remove, prune), `accessory-handler-service.ts` (handler factory, dispatch by type), `hap-prune-policy.ts`, `discovery-service.ts` (exclusions, exposure policy as exclusion, name provenance, the single per-device Matter policy), `accessories/*.ts` (`zone-accessory.ts`, `light-accessory.ts`, `cover-accessory.ts`, `gate-accessory.ts`, `scenario-accessory.ts`, `sensor-accessory.ts`, `thermostat-accessory.ts`; `communication-failure.ts` keeps the original error as `cause`; `hap-ranges.ts` holds the HomeKit ranges every accessory clamps a reading to; `missing-value-warning.ts` makes a getter warn when a value goes missing, not at every read).
- **Prune discipline:** `prune-policy.ts` is shared by HomeKit and Matter: floor of 50 % of the known accessories, family guard (a kind of device that did not answer is not judged), three consecutive misses, the panel probes as a family each.
- **Persistence and files:** `atomic-file.ts` (atomic writes with mode, symbolic links kept, in-place fallback, orphan cleanup), `config-file-service.ts` (safe update of the plugin block of `config.json`, with an outcome), `device-list-service.ts`, `room-mapping-example.ts`, `ksa-import-service.ts` and `ksa-config-merge.ts`.
- **Matter subsystem:**
  - `matter-accessory-registry.ts` (facade) with `matter-registration-flow.ts` (shape and registration), `matter-register-probe.ts` (learns whether register waits for the endpoint), `matter-registration-recovery.ts`, `matter-registration-gate.ts`, `matter-registry-state.ts`, `matter-registry-types.ts` (timings and their environment variables), `matter-endpoint-replacement.ts` (identity kept across a replacement), `matter-state-update-queue.ts`, `matter-state-updates.ts`, `matter-reachability.ts` (15 s grace).
  - `matter-topology-coordinator.ts`: process-wide serialization and locally observable register, unregister and rename-in-place.
  - `matter-device-mapper.ts`, `matter-command-handlers.ts`, `matter-light-capability.ts`, `matter-value-guards.ts`.
  - Thermostats: `matter-thermostat-mapper.ts` (cluster payload), `matter-thermostat-role.ts` (role and season, pure), `matter-thermostat-shape.ts` (payload choice per UUID), `matter-thermostat-attempts.ts` (attempt chain, role reshape), `matter-thermostat-role-wait.ts` (registration held until the output role is known), `matter-thermostat-push.ts` (a queued update rebuilt at send time with the acknowledged values), `matter-thermostat-handlers.ts`, `matter-thermostat-echo-tracker.ts` (acknowledged values), `matter-thermostat-recovery-request.ts`, `matter-fallback-store.ts` (versioned, never rewrites what it does not understand).
  - `matter-command-guard.ts`: per endpoint, the plugin's state pushes and the controller commands Homebridge runs never overlap (a push applied while a command runs made it fail with "Cannot lock … synchronously"); owned by the update queue, applied to every mapped accessory's handlers by the registration flow.
  - Names: `matter-name-service.ts`, `matter-name-map.ts`, `matter-name-sanitizer.ts`, `matter-name-store.ts` (atomic, version 2), `matter-name-finalizer.ts`, `matter-voice-analyzer.ts` (diagnostic only).
  - Prune: `matter-prune-tracker.ts`, `matter-prune-counters.ts`.

The top-level files `src/platform.ts`, `src/websocket-client.ts`, `src/mqtt-bridge.ts`, `src/debug-capture.ts` and `src/types.ts` are re-export shims; they hold no logic.

## Truth Boundaries

- **Commands.** A command progresses through `requested → queued → sent → acknowledged` (the answer carries `RESULT=OK`) or, for observable outputs, `state-confirmed` (the output really changed to the requested state, as a transition after the command was registered). A socket write alone is never a success; refusals, timeouts and a dropped connection reach the caller as errors.
- **Matter topology** progresses through `requested → published-unverified → locally-published`. What the plugin observes decides the state, not the return value of a register or unregister call: on some Homebridge versions the call returns before the endpoint exists, or removes nothing. Local queryability does not mean a controller has refreshed its own name.
- **Names.** Matter-only names and exposure are derived from source and custom names; they never mutate the HAP or MQTT device snapshot. The voice analysis only reports.
- **State.** A value the panel never reported is "not observed" (HomeKit No Response, Matter unknown), never a placeholder reading. Out-of-range or unreadable values are discarded, not clamped.
- **Panel.** A frame is trusted only after the shape and CRC check; a synchronization is complete only when the panel accepted the realtime registration.

## Exposure Policy (fail-closed)

One policy decides what exists, applied **before** anything enters the client state:

- Outputs: `determineOutputType` returns `undefined` for an unrecognized category (`GEN`, `IRR`, missing, unknown); `resolveOutputExposure` exposes such an output only if `exposeOutputs` lists it, as a light. `GATE` needs mode `M` to be a gate.
- Scenarios: `resolveScenarioExposure` (in `device-parsers.ts`) is an allowlist: `GEN` is exposed; `ARM` and `DISARM` never; `PARTIAL` only with `exposePartialArmScenarios`; any other category only through `exposeScenarios`.
- Hidden devices are recorded in `state.hiddenByExposurePolicy` (`exposure-report.ts`) and logged once; the client facade `isHiddenByExposurePolicy` and `DiscoveryService.isDeviceExcluded` make them count as **excluded** everywhere: the HAP and Matter prunes remove their cached accessories, MQTT neither publishes nor commands them, and the command service refuses a command for anything that is not a discovered device of that kind (defense in depth).
- The Matter eligibility reads only `resolveMatterPolicy`; the arming-scenario check is part of the exposure policy (`test/matter-eligibility-single-source.test.js`).

## Synchronization Lifecycle

`onSyncStarted` (each login) opens the HAP and Matter discovery cycles; the device router collects what the panel listed; at the end of the sync the HAP prune runs, then the Matter finalize (names) and prune, single-flight, so two syncs in quick succession do not overlap. The prune of both worlds is judged per sync, reconnections included.

## Release and CI

- `ci.yml`: `npm run verify` on Node 22, 24 and 26 and on the lower Node bound; the Matter contract tests (`npm run test:contract`) on Homebridge 2.4.x and 2.5.x; coverage thresholds on `src/`; `npm run check:pack` (tarball content allowlist, no source maps, no orphan build output).
- `release-publish.yml` (tag `v*`): job `build` (no publish rights: `scripts/release-guard.js`, `verify`, `npm pack`, `scripts/check-pack.js`, checksum, artifact) then job `publish` (environment `npm-publish`, no checkout, publishes the tarball with provenance). The tagged commit must be on `main`; a stable `X.Y.Z` requires a published `X.Y.Z-rc.N` with the same dependencies. All actions are pinned by commit SHA; Dependabot auto-merges only development dependencies and actions.

## Compatibility Contract

- No changes to plugin alias/name (`Lares4Complete` / `homebridge-plugin-klares4`), existing config keys, MQTT topic shapes or accessory UUID generation.
- No removals or renames in the exported runtime classes.
- Type additions are internal or additive only.
- Per-device configuration is an array of typed objects (the Homebridge UI drops maps keyed by device ID).
- A file of `src/` has at most 350 lines; split along the facade and service seams.

## Verification Gates

- `npm run verify`: `check:max-lines` (≤ 350 lines per `src/**/*.ts`), `tsc --noEmit --noUnusedLocals --noUnusedParameters`, the full suite (`node --test` on the built `dist/`).
- `npm run test:contract`, `npm run test:coverage`, `npm run check:pack` (see the README, Development).
- Documentation tests: the settings schema, the README tables and `docs/en` ↔ `docs/it` are checked against each other and against the runtime.
