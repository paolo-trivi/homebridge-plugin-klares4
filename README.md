# homebridge-plugin-klares4

[![npm version](https://badge.fury.io/js/homebridge-plugin-klares4.svg)](https://badge.fury.io/js/homebridge-plugin-klares4)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Complete plugin for Ksenia Lares4 systems integrating security zones, lights, covers, thermostats, and environmental sensors into a single Homebridge solution.

---

## English Documentation

### Features

- **Security Zones**: Contact sensors for doors and windows
- **Light Control**: On/off control for all system lights
- **Smart Covers**: Percentage control with configurable timing
- **Thermostats**: Temperature and heating/cooling mode control
- **Environmental Sensors**: Real-time temperature, humidity, and light levels
- **System Temperature Sensors**: Internal and external temperature from central unit
- **Real-time Updates**: WebSocket connection with automatic reconnection
- **UI Configuration**: Complete graphical interface in Homebridge UI
- **Customization**: Custom names and selective entity exclusion
- **MQTT Bridge**: State publishing and command reception via MQTT (optional)

### Prerequisites

- Homebridge >= 1.6.0
- Node.js >= 14.18.1
- Ksenia Lares4 system with WebSocket access enabled

### Installation

#### Via Homebridge UI (Recommended)

1. Open Homebridge UI
2. Go to **Plugins**
3. Search for `homebridge-plugin-klares4`
4. Click **Install**
5. Configure the plugin via the graphical interface

#### Via npm

```bash
npm install -g homebridge-plugin-klares4
```

### Configuration

#### Basic Configuration

The plugin can be fully configured via the Homebridge UI graphical interface. Required parameters:

- **Plugin Name**: Name that will appear in logs
- **IP Address**: IP of the Ksenia Lares4 system
- **Sender ID**: Unique identifier for WebSocket connection
- **System PIN**: Access PIN for the Lares4 system

#### Manual Configuration (config.json)

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
					"9": "Living Room Light",
					"1": "Office Blind"
				},
				"sensors": {
					"1": "Living Room Thermometer"
				}
			}
		}
	]
}
```

#### Configuration Parameters

| Parameter           | Type     | Default      | Description                     |
| ------------------- | -------- | ------------ | ------------------------------- |
| `name`              | string   | "Klares4"    | Plugin name                     |
| `ip`                | string   | required     | Lares4 system IP address        |
| `sender`            | string   | "homebridge" | Unique WebSocket ID             |
| `pin`               | string   | required     | Access PIN                      |
| `maxSeconds`        | number   | 30           | Max cover travel time (seconds) |
| `reconnectInterval` | number   | 5000         | Reconnection interval (ms)      |
| `heartbeatInterval` | number   | 30000        | Heartbeat interval (ms)         |
| `debug`             | boolean  | false        | Detailed logging                |
| `excludeZones`      | string[] | []           | Zones to exclude                |
| `excludeOutputs`    | string[] | []           | Outputs to exclude              |
| `excludeSensors`    | string[] | []           | Sensors to exclude              |
| `customNames`       | object   | {}           | Custom names                    |

### Supported Accessory Types

#### Security Zones

- **HomeKit Type**: Contact Sensor
- **States**: Open/Closed, Bypass
- **Updates**: Real-time via WebSocket

#### Lights

- **HomeKit Type**: Lightbulb
- **Control**: On/Off
- **Feedback**: Real-time state

#### Covers

- **HomeKit Type**: Window Covering
- **Control**: Percentage (0-100%)
- **Commands**: Up/Down/Stop
- **Timing**: Configurable via `maxSeconds`

#### Thermostats

- **HomeKit Type**: Thermostat
- **Modes**: Off/Heat/Cool
- **Control**: Target temperature
- **Sensors**: Current temperature

#### Environmental Sensors

- **HomeKit Types**: Temperature/Humidity/Light Sensor
- **Data**: Temperature, Humidity, Light level
- **Updates**: Real-time

### MQTT Bridge (Optional)

The plugin includes an MQTT bridge for publishing accessory states and receiving commands via MQTT.

#### MQTT Configuration

Enable the MQTT bridge in the "MQTT Bridge" configuration section:

```json
{
	"mqtt": {
		"enabled": true,
		"broker": "mqtt://192.168.1.100:1883",
		"username": "mqtt_user",
		"password": "mqtt_password",
		"clientId": "homebridge-klares4",
		"topicPrefix": "homebridge/klares4",
		"qos": 1,
		"retain": true
	}
}
```

#### State Publishing

Accessory states are published to the following topics:

- **Lights**: `homebridge/klares4/light/{id}/state`
- **Covers**: `homebridge/klares4/cover/{id}/state`
- **Thermostats**: `homebridge/klares4/thermostat/{id}/state`
- **Sensors**: `homebridge/klares4/sensor/{id}/state`
- **Zones**: `homebridge/klares4/zone/{id}/state`
- **Scenarios**: `homebridge/klares4/scenario/{id}/state`

#### Command Reception

Send commands to accessories on the following topics:

- **Lights**: `homebridge/klares4/light/{id}/set`
- **Covers**: `homebridge/klares4/cover/{id}/set`
- **Thermostats**: `homebridge/klares4/thermostat/{id}/set`
- **Scenarios**: `homebridge/klares4/scenario/{id}/set`

#### Usage Examples

##### Turn on a light:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/light/1/set" -m '{"on": true, "brightness": 80}'
```

##### Move a cover:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/cover/2/set" -m '{"position": 50}'
```

##### Set thermostat temperature:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/thermostat/3/set" -m '{"targetTemperature": 22, "mode": "heat"}'
```

##### Trigger a scenario:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/scenario/4/set" -m '{"active": true}'
```

### Troubleshooting

#### WebSocket Connection

If the plugin cannot connect:

1. Verify the IP address is correct
2. Check that the PIN is valid
3. Ensure the Lares4 system accepts WebSocket connections
4. Verify port 443 (HTTPS) or 80 (HTTP) is accessible

#### Debug

Enable debug logging for detailed diagnostics:

```json
{
	"debug": true
}
```

### Roadmap

#### Planned for v1.1.8-beta

The following entity types are currently not supported but are planned for the next beta release:

##### 🚿 Irrigation Systems (IRR)

- **Type**: Switch (bistable)
- **Examples**: Drip irrigation, garden zones, lawn sprinklers
- **HomeKit Mapping**: Valve/Switch accessories
- **Status**: Planned

##### 🔔 Indicators & Status LEDs (GEN, MOD:S)

- **Type**: Read-only sensors/switches
- **Examples**: Zone status indicators, system LEDs
- **HomeKit Mapping**: Contact Sensor (read-only)
- **Status**: Planned

##### 🚨 Sirens & Alarms (GEN, MOD:AT)

- **Type**: Switch (manual control)
- **Examples**: External siren, internal siren
- **HomeKit Mapping**: Switch with security considerations
- **Status**: Under evaluation

##### 🔗 Alarm Bridges (GEN, MOD:A)

- **Type**: Read-only sensors
- **Examples**: State bridges, alarm bridges
- **HomeKit Mapping**: Contact Sensor (read-only)
- **Status**: Planned

**Note**: These features will be implemented based on user feedback and testing. If you have one of these devices and would like to help with testing, please open an issue on GitHub.

### License

This project is released under the MIT license.

### Useful Links

- [Homebridge](https://homebridge.io/)
- [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x)
- [Ksenia Security](https://www.kseniasecurity.com/)

---

## Documentazione Italiana

### Caratteristiche

- **Zone di Sicurezza**: Sensori di contatto per porte e finestre
- **Controllo Luci**: Accensione/spegnimento di tutte le luci del sistema
- **Tapparelle Intelligenti**: Controllo percentuale con timing configurabile
- **Termostati**: Controllo temperatura e modalita riscaldamento/raffreddamento
- **Sensori Ambientali**: Temperatura, umidita e luminosita in tempo reale- **Sensori Temperatura Sistema**: Temperatura interna ed esterna dalla centrale- **Aggiornamenti Real-time**: Connessione WebSocket con riconnessione automatica
- **Configurazione UI**: Interfaccia grafica completa in Homebridge UI
- **Personalizzazione**: Nomi personalizzati ed esclusione selettiva di entita
- **Bridge MQTT**: Pubblicazione stati e ricezione comandi via MQTT (opzionale)

### Prerequisiti

- Homebridge >= 1.6.0
- Node.js >= 14.18.1
- Sistema Ksenia Lares4 con accesso WebSocket abilitato

### Installazione

#### Tramite Homebridge UI (Consigliato)

1. Apri Homebridge UI
2. Vai su **Plugins**
3. Cerca `homebridge-plugin-klares4`
4. Clicca **Install**
5. Configura il plugin tramite l'interfaccia grafica

#### Tramite npm

```bash
npm install -g homebridge-plugin-klares4
```

### Configurazione

#### Configurazione Base

Il plugin puo essere configurato completamente tramite l'interfaccia grafica di Homebridge UI. I parametri obbligatori sono:

- **Nome Plugin**: Nome che apparira nei log
- **Indirizzo IP**: IP del sistema Ksenia Lares4
- **Sender ID**: Identificativo univoco per la connessione WebSocket
- **PIN Sistema**: PIN di accesso al sistema Lares4

#### Configurazione Manuale (config.json)

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
					"1": "Porta Principale",
					"2": "Finestra Cucina"
				},
				"outputs": {
					"9": "Luce Sala Custom",
					"1": "Tapparella Studio"
				},
				"sensors": {
					"1": "Termometro Sala"
				}
			}
		}
	]
}
```

#### Parametri di Configurazione

| Parametro           | Tipo     | Default      | Descrizione                     |
| ------------------- | -------- | ------------ | ------------------------------- |
| `name`              | string   | "Klares4"    | Nome del plugin                 |
| `ip`                | string   | obbligatorio | Indirizzo IP del sistema Lares4 |
| `sender`            | string   | "homebridge" | ID univoco per WebSocket        |
| `pin`               | string   | obbligatorio | PIN di accesso                  |
| `maxSeconds`        | number   | 30           | Tempo max tapparelle (secondi)  |
| `reconnectInterval` | number   | 5000         | Intervallo riconnessione (ms)   |
| `heartbeatInterval` | number   | 30000        | Intervallo heartbeat (ms)       |
| `debug`             | boolean  | false        | Logging dettagliato             |
| `excludeZones`      | string[] | []           | Zone da escludere               |
| `excludeOutputs`    | string[] | []           | Output da escludere             |
| `excludeSensors`    | string[] | []           | Sensori da escludere            |
| `customNames`       | object   | {}           | Nomi personalizzati             |

### Tipi di Accessori Supportati

#### Zone di Sicurezza

- **Tipo HomeKit**: Contact Sensor
- **Stati**: Aperto/Chiuso, Bypass
- **Aggiornamenti**: Real-time via WebSocket

#### Luci

- **Tipo HomeKit**: Lightbulb
- **Controllo**: On/Off
- **Feedback**: Stato real-time

#### Tapparelle

- **Tipo HomeKit**: Window Covering
- **Controllo**: Percentuale (0-100%)
- **Comandi**: Su/Giu/Stop
- **Timing**: Configurabile tramite `maxSeconds`

#### Termostati

- **Tipo HomeKit**: Thermostat
- **Modalita**: Off/Heat/Cool
- **Controllo**: Temperatura target
- **Sensori**: Temperatura corrente

#### Sensori Ambientali

- **Tipi HomeKit**: Temperature/Humidity/Light Sensor
- **Dati**: Temperatura, Umidita, Luminosita
- **Aggiornamenti**: Real-time

### Bridge MQTT (Opzionale)

Il plugin include un bridge MQTT che permette di pubblicare gli stati degli accessori e ricevere comandi via MQTT.

#### Configurazione MQTT

Abilita il bridge MQTT nella sezione "MQTT Bridge" della configurazione:

```json
{
	"mqtt": {
		"enabled": true,
		"broker": "mqtt://192.168.1.100:1883",
		"username": "mqtt_user",
		"password": "mqtt_password",
		"clientId": "homebridge-klares4",
		"topicPrefix": "homebridge/klares4",
		"qos": 1,
		"retain": true
	}
}
```

#### Pubblicazione Stati

Gli stati degli accessori vengono pubblicati sui seguenti topic:

- **Luci**: `homebridge/klares4/light/{id}/state`
- **Tapparelle**: `homebridge/klares4/cover/{id}/state`
- **Termostati**: `homebridge/klares4/thermostat/{id}/state`
- **Sensori**: `homebridge/klares4/sensor/{id}/state`
- **Zone**: `homebridge/klares4/zone/{id}/state`
- **Scenari**: `homebridge/klares4/scenario/{id}/state`

#### Ricezione Comandi

Invia comandi agli accessori sui seguenti topic:

- **Luci**: `homebridge/klares4/light/{id}/set`
- **Tapparelle**: `homebridge/klares4/cover/{id}/set`
- **Termostati**: `homebridge/klares4/thermostat/{id}/set`
- **Scenari**: `homebridge/klares4/scenario/{id}/set`

#### Esempi di Utilizzo

##### Accendere una luce:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/light/1/set" -m '{"on": true, "brightness": 80}'
```

##### Muovere una tapparella:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/cover/2/set" -m '{"position": 50}'
```

##### Impostare temperatura termostato:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/thermostat/3/set" -m '{"targetTemperature": 22, "mode": "heat"}'
```

##### Attivare uno scenario:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/scenario/4/set" -m '{"active": true}'
```

### Risoluzione Problemi

#### Connessione WebSocket

Se il plugin non riesce a connettersi:

1. Verifica che l'IP sia corretto
2. Controlla che il PIN sia valido
3. Assicurati che il sistema Lares4 accetti connessioni WebSocket
4. Verifica che la porta 443 (HTTPS) o 80 (HTTP) sia accessibile

#### Debug

Abilita il debug logging per diagnosi dettagliate:

```json
{
	"debug": true
}
```

### Contributi

I contributi sono benvenuti! Per contribuire:

1. Fork del repository
2. Crea un branch per la tua feature
3. Commit delle modifiche
4. Push al branch
5. Apri una Pull Request

### Licenza

Questo progetto e rilasciato sotto licenza MIT.

### Roadmap

#### Pianificato per v1.1.8-beta

I seguenti tipi di entità non sono attualmente supportati ma sono pianificati per la prossima release beta:

##### 🚿 Sistemi di Irrigazione (IRR)

- **Tipo**: Switch (bistabile)
- **Esempi**: Irrigazione a goccia, zone giardino, irrigatori
- **Mappatura HomeKit**: Accessori Valve/Switch
- **Stato**: Pianificato

##### 🔔 Indicatori e LED di Stato (GEN, MOD:S)

- **Tipo**: Sensori/switch in sola lettura
- **Esempi**: Spie stato zone, LED di sistema
- **Mappatura HomeKit**: Sensore di contatto (sola lettura)
- **Stato**: Pianificato

##### 🚨 Sirene e Allarmi (GEN, MOD:AT)

- **Tipo**: Switch (controllo manuale)
- **Esempi**: Sirena esterna, sirena interna
- **Mappatura HomeKit**: Switch con considerazioni di sicurezza
- **Stato**: In valutazione

##### 🔗 Ponti Allarme (GEN, MOD:A)

- **Tipo**: Sensori in sola lettura
- **Esempi**: Ponti di stato, ponti allarme
- **Mappatura HomeKit**: Sensore di contatto (sola lettura)
- **Stato**: Pianificato

**Nota**: Queste funzionalità verranno implementate in base al feedback degli utenti e ai test. Se hai uno di questi dispositivi e desideri aiutare con i test, apri una issue su GitHub.

### Link Utili

- [Homebridge](https://homebridge.io/)
- [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x)
- [Ksenia Security](https://www.kseniasecurity.com/)

---

**Note**: This project is not affiliated with Ksenia Security S.p.A. It is an open source project developed by the community.

**Nota**: Questo progetto non e affiliato con Ksenia Security S.p.A. E un progetto open source sviluppato dalla comunita.
