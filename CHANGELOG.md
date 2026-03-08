# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
