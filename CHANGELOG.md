# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.6-beta.4] - 2026-01-11

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
