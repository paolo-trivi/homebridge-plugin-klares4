# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- Enhanced config schema with new "Mappatura Stanze MQTT" section
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
  - 🔐 Security zones (contact sensors)
  - 💡 Lights with on/off control
  - 🪟 Window coverings with position control
  - 🌡️ Thermostats with temperature and mode control
  - 📊 Environmental sensors (temperature, humidity, light)
  - 🎬 Scenario automation triggers
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

### From 1.1.1-beta.0 to 1.1.1-beta.1+
- Room mapping is optional and disabled by default
- Existing MQTT configurations continue to work unchanged
- To use room mapping, enable it in the new "Mappatura Stanze MQTT" section

### From 1.0.x to 1.1.0+
- Complete reconfiguration required
- New device discovery process
- Enhanced configuration options through Homebridge UI
- Improved stability and performance

## Support

For issues, feature requests, or questions:
- GitHub Issues: https://github.com/paolo-trivi/homebridge-plugin-klares4/issues
- Documentation: Check README.md for detailed setup instructions