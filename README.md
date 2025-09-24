# homebridge-plugin-klares4

[![npm version](https://badge.fury.io/js/homebridge-plugin-klares4.svg)](https://badge.fury.io/js/homebridge-plugin-klares4)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Complete plugin for Ksenia Lares4 security systems that integrates security zones, lights, shutters, thermostats and environmental sensors into a single Homebridge solution.

## ✨ Features

- 🔐 **Security Zones**: Contact sensors for doors and windows
- 💡 **Light Control**: On/off control of all system lights
- 🪟 **Smart Shutters**: Percentage control with configurable timing
- 🌡️ **Thermostats**: Temperature control and heating/cooling modes
- 📊 **Environmental Sensors**: Real-time temperature, humidity and brightness
- 🔄 **Real-time Updates**: WebSocket connection with automatic reconnection
- ⚙️ **UI Configuration**: Complete graphical interface in Homebridge UI
- 🎯 **Customization**: Custom names and selective entity exclusion

## 📋 Prerequisites

- Homebridge >= 1.6.0
- Node.js >= 14.18.1
- Ksenia Lares4 system with WebSocket access enabled

## 🚀 Installation

### Via Homebridge UI (Recommended)

1. Open Homebridge UI
2. Go to **Plugins**
3. Search for `homebridge-plugin-klares4`
4. Click **Install**
5. Configure the plugin via the graphical interface

### Via npm

```bash
npm install -g homebridge-plugin-klares4
```

## ⚙️ Configuration

### Basic Configuration

The plugin can be fully configured through the Homebridge UI graphical interface. The mandatory parameters are:

- **Plugin Name**: Name that will appear in logs
- **IP Address**: IP of the Ksenia Lares4 system
- **Sender ID**: Unique identifier for WebSocket connection
- **System PIN**: Access PIN for the Lares4 system

### Manual Configuration (config.json)

```json
{
	"platforms": [
		{
			"platform": "Lares4Complete",
			"name": "Klares4",
			"ip": "192.168.1.100",
			"sender": "homebridge",
			"pin": "123456",
			"maxSeconds": 30,
			"reconnectInterval": 5000,
			"heartbeatInterval": 30000,
			"debug": false,
			"excludeZones": ["1", "5"],
			"excludeOutputs": ["2", "7"],
			"excludeSensors": ["3"],
			"customNames": {
				"zones": {
					"1": "Main Door",
					"2": "Kitchen Window"
				},
				"outputs": {
					"9": "Custom Living Light",
					"1": "Study Shutter"
				},
				"sensors": {
					"1": "Living Thermometer"
				}
			}
		}
	]
}
```

### Configuration Parameters

| Parameter           | Type     | Default      | Description                         |
| ------------------- | -------- | ------------ | ----------------------------------- |
| `name`              | string   | "Klares4"    | Plugin name                         |
| `ip`                | string   | mandatory    | IP address of Lares4 system        |
| `sender`            | string   | "homebridge" | Unique ID for WebSocket             |
| `pin`               | string   | mandatory    | Access PIN                          |
| `maxSeconds`        | number   | 30           | Max shutter time (seconds)          |
| `reconnectInterval` | number   | 5000         | Reconnection interval (ms)          |
| `heartbeatInterval` | number   | 30000        | Heartbeat interval (ms)             |
| `debug`             | boolean  | false        | Detailed logging                    |
| `excludeZones`      | string[] | []           | Zones to exclude                    |
| `excludeOutputs`    | string[] | []           | Outputs to exclude                  |
| `excludeSensors`    | string[] | []           | Sensors to exclude                  |
| `customNames`       | object   | {}           | Custom names                        |

## 🏠 Supported Accessory Types

### Security Zones

- **HomeKit Type**: Contact Sensor
- **States**: Open/Closed, Bypass
- **Updates**: Real-time via WebSocket

### Lights

- **HomeKit Type**: Lightbulb
- **Control**: On/Off
- **Feedback**: Real-time status

### Shutters

- **HomeKit Type**: Window Covering
- **Control**: Percentage (0-100%)
- **Commands**: Up/Down/Stop
- **Timing**: Configurable via `maxSeconds`

### Thermostats

- **HomeKit Type**: Thermostat
- **Modes**: Off/Heat/Cool
- **Control**: Target temperature
- **Sensors**: Current temperature

### Environmental Sensors

- **HomeKit Types**: Temperature/Humidity/Light Sensor
- **Data**: Temperature, Humidity, Brightness
- **Updates**: Real-time

## 🔧 Troubleshooting

### WebSocket Connection

If the plugin fails to connect:

1. Verify the IP address is correct
2. Check that the PIN is valid
3. Ensure the Lares4 system accepts WebSocket connections
4. Verify that port 443 (HTTPS) or 80 (HTTP) is accessible

### Debug

Enable debug logging for detailed diagnostics:

```json
{
	"debug": true
}
```

### Serial Number Warning

The warning "Serial Number characteristic must have a length of more than 1 character" has been resolved in recent versions. Make sure you have the latest plugin version.

### Unresponsive Shutters

If shutters don't respond correctly:

1. Check the `maxSeconds` parameter
2. Verify that up, down, alt commands are supported by the system
3. Test first with complete movements (0% or 100%)

## 📊 Monitoring

The plugin provides detailed logs to monitor:

- WebSocket connection status
- Commands sent and received
- Entity updates
- Errors and reconnections

## 🤝 Contributing

Contributions are welcome! To contribute:

1. Fork the repository
2. Create a branch for your feature
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

This project is released under MIT license.

## 🔗 Useful Links

- [Homebridge](https://homebridge.io/)
- [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x)
- [Ksenia Security](https://www.ksenia.it/)

---

**Note**: This project is not affiliated with Ksenia Security S.p.A. It is an open source project developed by the community.
