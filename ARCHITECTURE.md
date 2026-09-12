# Architecture Overview

This document describes the modular architecture delivered for `2.0.0-beta.0` without breaking external behavior.

## Design Goals

- Preserve runtime and configuration compatibility with existing Homebridge installations.
- Reduce class responsibilities and duplicate logic.
- Improve testability of protocol, mapping, and lifecycle behaviors.

## Layered Hierarchy

### 1) Communication Layer

- WebSocket:
  - Public facade: `KseniaWebSocketClient` (`websocket-client/index.ts`)
  - Internal modules:
    - `websocket/command-dispatcher.ts`: per-device queue, unique pending IDs, strict response correlation and positive-result validation.
    - `websocket/output-command-confirmation.ts`: bounded realtime-state confirmation for observable output writes.
    - `websocket/protocol-router.ts`: command routing by `CMD`/`PAYLOAD_TYPE`.
    - `websocket/device-state-projector.ts`: parse/mapping utilities from protocol payloads.
    - `websocket/ws-transport.ts`: transport helpers for send/ping/close.
- MQTT:
  - Public facade: `MqttBridge` (`mqtt-bridge/index.ts`)
  - Internal modules:
    - `mqtt/topic-parser.ts`: topic parse/build and slug generation.
    - `mqtt/state-payload-mapper.ts`: stable state payload mapping.
- Diagnostics transport capture:
  - Public facade: `DebugCaptureManager` (`debug-capture/index.ts`)
  - Internal modules:
    - `debug-capture/raw-message-capture.ts`: raw message parse/mask (`PIN` masking).
    - `debug-capture/analysis.ts`: command and payload statistics.
    - `debug-capture/file-generator.ts`: debug artifact assembly and file write.

### 2) Domain Layer

- Device identity SSoT:
  - `device-id.ts`: canonical id parsing/building utilities.
- Thermostat domain semantics:
  - `thermostat-mode.ts`: Ksenia/domain/HomeKit mode mapping.
  - `thermostat-state.ts`: canonical thermostat status + compatibility top-level sync.
- Accessory domain behavior:
  - `accessories/*.ts`: HomeKit behavior adapters by device type.

### 3) Infrastructure Layer

- Homebridge platform orchestration:
  - Public facade: `Lares4Platform` (`platform/index.ts`)
  - Internal services:
    - `platform/accessory-registry.ts`: cache/add/update/remove/prune accessory lifecycle.
    - `platform/accessory-handler-service.ts`: handler factory + status dispatch by device type.
    - `platform/discovery-service.ts`: global exclusions, derived name provenance and the single per-device Matter policy resolver.
    - `platform/device-list-service.ts`: device persistence + summary logging + room mapping example generation.
    - `platform/config-file-service.ts`: safe update of `generateDebugFile` in `config.json`.
    - `platform/platform-lifecycle-service.ts`: timers and shutdown lifecycle helpers.
  - Matter subsystem:
    - `platform/matter-accessory-registry.ts`: Matter registration facade and state-update orchestration.
    - `platform/matter-topology-coordinator.ts`: process-wide serialization and locally observable register/unregister states.
    - `platform/matter-name-service.ts` / `matter-name-store.ts`: deterministic name map, validated v2 persistence and reserved slots.
    - `platform/matter-voice-analyzer.ts`: deterministic, read-only collision diagnostics; it never mutates names.
    - `platform/matter-prune-tracker.ts`: persisted consecutive-miss pruning with partial-sync guards.
    - `platform/matter-fallback-store.ts` / `matter-thermostat-recovery-request.ts`: versioned fallback state and explicit one-shot Thermostat recovery.

## Truth Boundaries

- Command writes progress through `requested -> sent -> acknowledged` or, for observable outputs, `state-confirmed`. A socket write alone is never success.
- Matter topology progresses through `requested -> published-unverified -> locally-published`. Local queryability does not mean a controller has refreshed its own name or voice index.
- Matter-only names and exposure are derived from source/custom names without mutating the HAP or MQTT device snapshot.

## Compatibility Contract

- No changes to plugin alias/name, config keys, topic shapes, or accessory UUID generation.
- No removals/renames in exported runtime classes.
- Type additions are internal or additive only.

## Verification Gates

- `npm run check:max-lines` (enforces max 350 lines per `src/**/*.ts`)
- `npm test`
- `npx tsc --noEmit`
- `npm run build`
