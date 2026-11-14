# Klares4 Docs (EN)

## Contents

1. [Plugin Overview](./plugin-overview.md)
2. [Configuration and UI](./config-and-ui.md)
3. [WebSocket Protocol](./websocket-protocol.md)
4. [Domus Thermostats and KSA](./domus-thermostats.md)
5. [MQTT Bridge](./mqtt.md)
6. [Matter](./matter.md)
7. [Privacy and the Debug File](./privacy-and-debug-file.md)
8. [Operations and Troubleshooting](./operations-debug.md)

## Scope

These documents describe how the plugin works in production today:

- Homebridge platform lifecycle and synchronization
- configuration reading, exposure policy and the settings form
- WebSocket request/response/realtime flows, command lifecycle and login guard
- thermostat state and command routing
- MQTT bridge behavior, availability topic and security
- Matter behavior, thermostats, identity, removal and troubleshooting
- KSA import and sanitized cache
- privacy, the confidential debug file and the diagnostic workflow

The italian version is in [`../it/`](../it/README.md), page by page. The module map is in [`ARCHITECTURE.md`](../../ARCHITECTURE.md), user-facing changes are in [`CHANGELOG.md`](../../CHANGELOG.md).
