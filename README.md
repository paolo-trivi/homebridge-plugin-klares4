# homebridge-plugin-klares4

**Bring your Ksenia Lares4 alarm system into Apple HomeKit — and Matter** — security zones, lights, covers, thermostats and environmental sensors, all from a single Homebridge plugin. Local-only via WebSocket, no cloud required. Full **Matter** support via Homebridge 2.x: the same accessories are exposed to Google Home, Amazon Alexa and SmartThings.

[![npm version](https://img.shields.io/npm/v/homebridge-plugin-klares4.svg?logo=npm)](https://www.npmjs.com/package/homebridge-plugin-klares4)
[![npm downloads](https://img.shields.io/npm/dm/homebridge-plugin-klares4.svg?logo=npm)](https://www.npmjs.com/package/homebridge-plugin-klares4)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![Node](https://img.shields.io/node/v/homebridge-plugin-klares4.svg?logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/paolo-trivi/homebridge-plugin-klares4.svg?style=social)](https://github.com/paolo-trivi/homebridge-plugin-klares4/stargazers)

![Lares4 devices in the Apple Home app](https://raw.githubusercontent.com/paolo-trivi/homebridge-plugin-klares4/main/docs/images/home-app-rooms.png)

*Zones, lights, covers, thermostats and Ksenia scenarios appear as native HomeKit accessories, grouped by room.*

![Climate category in Home app — temperature, humidity, covers and fans from Lares4](https://raw.githubusercontent.com/paolo-trivi/homebridge-plugin-klares4/main/docs/images/home-app-climate.png)

*Environmental sensors and climate controls integrate into the Home app's category views (Climate, Security, Lights).*

---

## Why this plugin?

| | **homebridge-plugin-klares4** | Home Assistant + HomeKit Bridge | Ksenia ergo / Lares 4.0 app | None (no HomeKit) |
|---|---|---|---|---|
| Native HomeKit (Siri, scenes, automations) | ✅ | ✅ (via HA bridge) | ❌ | ❌ |
| **Matter** (Google Home, Alexa, SmartThings) | ✅ via Homebridge 2.x | ✅ via HA Matter Server | ❌ | ❌ |
| Works **fully local** (no cloud) | ✅ | ✅ | depends | n/a |
| Setup effort | Install + IP/PIN | Full HA stack required | Already installed | n/a |
| Zones, lights, covers, thermostats, env. sensors | ✅ all in one | ✅ (community/HACS, if any) | ✅ (Ksenia UI only) | n/a |
| Thermostat handling tuned for Matter (echo guard, endpoint recovery) | ✅ | partial | n/a | n/a |
| MQTT bridge built-in | ✅ optional | via HA | ❌ | n/a |
| Real-time updates (WebSocket) | ✅ | ✅ | ✅ | n/a |
| `.ksa` backup import for routing & room mapping | ✅ | ❌ | n/a | n/a |
| Maintained, in active development | ✅ | community | vendor | n/a |
| Open source | ✅ MIT | ✅ | ❌ | n/a |

If you already run Home Assistant, both options are valid; this plugin is the simplest path if your hub is already Homebridge.

## Matter support

Running on **Homebridge 2.x**, every Lares4 accessory exposed by this plugin is automatically reachable via Matter — meaning the same lights, covers, thermostats and sensors that show up in the Apple Home app also work in **Google Home**, **Amazon Alexa** and **Samsung SmartThings**, all over your local network.

The plugin includes Matter-specific reliability code that has been tested in real installations:

- **Thermostat echo guard** — suppresses spurious round-trip updates from Matter controllers, so target temperatures and modes don't flicker.
- **Stale endpoint recovery** — when a Matter endpoint becomes stale after a controller restart, the plugin detects and rebuilds it instead of leaving a ghost accessory.
- **Mode and temperature mapping** tailored for Matter clusters (heat/cool/auto, setpoint ranges) so commands from any ecosystem reach the panel correctly.

No extra configuration is required: enable Matter in Homebridge and pair the bridge with your preferred ecosystem.

## Voice commands (Alexa / Siri / Google)

Voice assistants resolve utterances by the **exact, unique device name**: "accendi lo studio" works reliably only if exactly one device is named *Studio*. This plugin is built around that rule:

- **Names come from the panel and are the source of truth.** The label you configured in the Lares4 (`DES`) is what you pronounce — the plugin never invents names, it only cleans them (trims stray spaces, replaces characters HomeKit rejects like `+` and parentheses: `Inserisci Finestre+Tapparelle` → `Inserisci Finestre e Tapparelle`).
- **The controllable device always owns the clean name.** When a cover and a security zone share the same label (common for windows: the *Finestra Studio* cover and the *Finestra Studio* contact zone), the cover/light/thermostat keeps the clean name and the passive sensor gets a ` - Sens.` suffix — so "chiudi finestra studio" always reaches the cover, never the contact sensor.
- **Names are deterministic and stable across reboots.** The final name for every device is computed in one batch when discovery completes and persisted to `klares4-matter-names.json` in the Homebridge storage folder. From then on every accessory registers with its final name from the very first instant of every boot, regardless of discovery order — controllers never see a rename, so their cached voice targets stay valid. The end-of-sync log prints the full `name → uuid` table and warns loudly if two devices ever ended up with the same name (which the map prevents by construction).
- **Room commands need a one-time room setup in the controller.** "Accendi lo studio" as a *room* command (all lights in the room) requires assigning devices to rooms inside Apple Home / Alexa / Google Home — room membership is not conveyed via Matter. Do it once per controller; it survives reboots because device identities (UUID/serial) never change.
- **Custom aliases are a controller feature.** Matter has no alias concept: if you want "la finestra grande" to mean `Finestra Matrimoniale`, define the alias in the Alexa/Google/Apple app.

### Voice-first installations: trim the namespace with `matterExposure`

On a 100+ endpoint bridge the voice namespace gets crowded — 39 contact zones with names like *Finestra Studio - Sens.* sit vocally close to the covers you actually command. If you don't need them on voice assistants, hide entire device types from Matter (HomeKit/HAP and the MQTT bridge are unaffected):

```json
"matterExposure": {
  "zones": false,
  "sensors": false
}
```

Available keys: `zones`, `sensors`, `scenarios`, `lights`, `covers`, `gates`, `thermostats` (all default `true`). Endpoints of a type you disable are removed automatically after 3 consecutive discovery cycles (the same conservative prune discipline that protects against transient discovery glitches).

## Updating the plugin (important)

**Always update in place** (Homebridge UI → Plugins → Update, or `npm update -g homebridge-plugin-klares4`).

**Never uninstall/reinstall the plugin and never delete or regenerate the Matter child bridge** to "fix" an issue: doing so regenerates the bridge username and the Matter storage, which destroys the commissioned fabrics — every controller (Apple Home, Alexa, Google) sees a brand-new bridge and you have to re-pair and rebuild rooms/automations from scratch. This is not theoretical; it happened in a production installation on 2026-07-05.

In-place updates are safe by design: accessory UUIDs, serial numbers and Matter endpoint identities are stable across versions, and the plugin re-registers the same accessories on every boot precisely so that pairings, rooms and automations survive.

## Compatibility

Tested with **Ksenia Lares 4.0** central units (firmware exposing the `KS_WSOCK` WebSocket subprotocol on the panel's local IP, with a valid system PIN). If your specific Lares 4.0 model works or has issues, please open an issue so the compatibility list can grow.

Requires Homebridge `>= 1.6.0` (also compatible with the 2.x beta line) and Node.js `>= 20`. **Matter support requires Homebridge 2.x.**

---

## Full Documentation

- English docs: [`docs/en/`](docs/en/)
- Documentazione italiana: [`docs/it/`](docs/it/)
- Internal architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md)

If this plugin saves you time, please ⭐ the repo — it really helps others discover it.

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
- **Command ACK & Timeout**: Write commands wait for API response with configurable timeout
- **Matter Support**: Automatic Matter exposure via Homebridge 2.x (Google Home, Alexa, SmartThings)
- **UI Configuration**: Complete graphical interface in Homebridge UI
- **Customization**: Custom names and selective entity exclusion
- **MQTT Bridge**: State publishing and command reception via MQTT (optional)
- **Documented Internal Architecture**: See `ARCHITECTURE.md` for module responsibilities and flows

### Prerequisites

- Homebridge >= 1.6.0 (Homebridge 2.x required for Matter)
- Node.js >= 20.0.0
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
| `commandTimeoutMs`  | number   | 8000         | API command response timeout (ms) |
| `allowInsecureTls`  | boolean  | false        | Disable TLS certificate validation (trusted LAN only) |
| `logLevel`          | number   | 1            | 0=minimal, 1=normal, 2=debug    |
| `domusThermostat`   | object   | enabled/freshness defaults | DOMUS thermostat mapping, manual overrides, freshness fallback |
| `ksaImport`         | object   | disabled     | Import KSA backup metadata for thermostat routing, room mapping and optional config apply |
| `debug`             | boolean  | false        | Detailed logging                |
| `telemetry`         | boolean  | true         | Anonymous error reporting       |
| `excludeZones`      | string[] | []           | Zones to exclude                |
| `excludeOutputs`    | string[] | []           | Outputs to exclude              |
| `excludeSensors`    | string[] | []           | Sensors to exclude              |
| `matterExposure`    | object   | all `true`   | Per-type Matter exposure switches (`zones`, `sensors`, `scenarios`, `lights`, `covers`, `gates`, `thermostats`) — Matter side only, see [Voice commands](#voice-commands-alexa--siri--google) |
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
- **Modes**: Off/Heat/Cool/Auto
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

- **Lights**: `homebridge/klares4/light/{slug}/state`
- **Covers**: `homebridge/klares4/cover/{slug}/state`
- **Thermostats**: `homebridge/klares4/thermostat/{slug}/state`
- **Sensors**: `homebridge/klares4/sensor/{slug}/state`
- **Zones**: `homebridge/klares4/zone/{slug}/state`
- **Scenarios**: `homebridge/klares4/scenario/{slug}/state`

#### Command Reception

Send commands to accessories on the following topics:

- **Lights**: `homebridge/klares4/light/{device_id_or_slug}/set`
- **Covers**: `homebridge/klares4/cover/{device_id_or_slug}/set`
- **Thermostats**: `homebridge/klares4/thermostat/{device_id_or_slug}/set`
- **Scenarios**: `homebridge/klares4/scenario/{device_id_or_slug}/set`

Examples of canonical device IDs: `light_1`, `cover_2`, `thermostat_3`, `scenario_4`.

#### Usage Examples

##### Turn on a light:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/light/light_1/set" -m '{"on": true, "brightness": 80}'
```

##### Move a cover:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/cover/cover_2/set" -m '{"position": 50}'
```

##### Set thermostat temperature:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/thermostat/thermostat_3/set" -m '{"targetTemperature": 22, "mode": "heat"}'
```

##### Trigger a scenario:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/scenario/scenario_4/set" -m '{"active": true}'
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

#### Telemetry

By default, the plugin anonymously reports technical errors to the developer via Sentry. This helps identify and fix bugs faster. Strict sanitization ensures your PIN, panel IP, tokens, client IP, configuration and custom device names are **never** transmitted. 
If you prefer not to send error reports, you can opt out by adding:

```json
{
	"telemetry": false
}
```

### Development Quality Gates

For local validation before publishing:

```bash
npm run verify
```

This runs:

- max file size gate (`src/**/*.ts` <= 350 lines),
- strict TypeScript checks (`--noUnusedLocals --noUnusedParameters`),
- full test suite,
- build compatibility gate.

### CI/CD

GitHub Actions workflows:

- `CI` (`.github/workflows/ci.yml`): Node 20/22 validation, strict type-checks, tests, build artifact.
- `Release Publish` (`.github/workflows/release-publish.yml`): npm publish with provenance from tags (`v*`) or manual dispatch.

Trusted publishing:

- `Release Publish` uses GitHub OIDC trusted publishing (`id-token: write`).
- No `NPM_TOKEN` secret is required.

Release policy:

- tag push `v<package.json version>` triggers publish;
- npm dist-tag auto-derived from version:
  - `*-beta*` -> `beta`
  - `*-rc*` -> `rc`
  - stable -> `latest`

### Roadmap

#### Planned for v1.2.0

The following entity types are currently not supported but are planned for a future release:

##### Irrigation Systems (IRR)

- **Type**: Switch (bistable)
- **Examples**: Drip irrigation, garden zones, lawn sprinklers
- **HomeKit Mapping**: Valve/Switch accessories
- **Status**: Planned

##### Indicators & Status LEDs (GEN, MOD:S)

- **Type**: Read-only sensors/switches
- **Examples**: Zone status indicators, system LEDs
- **HomeKit Mapping**: Contact Sensor (read-only)
- **Status**: Planned

##### Sirens & Alarms (GEN, MOD:AT)

- **Type**: Switch (manual control)
- **Examples**: External siren, internal siren
- **HomeKit Mapping**: Switch with security considerations
- **Status**: Under evaluation

##### Alarm Bridges (GEN, MOD:A)

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

**Porta il tuo sistema d'allarme Ksenia Lares4 dentro Apple HomeKit — e Matter** — zone di sicurezza, luci, tapparelle, termostati e sensori ambientali, tutto da un unico plugin Homebridge. Solo locale via WebSocket, nessun cloud richiesto. Supporto **Matter** completo tramite Homebridge 2.x: gli stessi accessori vengono esposti a Google Home, Amazon Alexa e SmartThings.

### Perche questo plugin?

| | **homebridge-plugin-klares4** | Home Assistant + Bridge HomeKit | App Ksenia ergo / Lares 4.0 | Nessuna integrazione |
|---|---|---|---|---|
| HomeKit nativo (Siri, scene, automazioni) | ✅ | ✅ (via bridge HA) | ❌ | ❌ |
| **Matter** (Google Home, Alexa, SmartThings) | ✅ via Homebridge 2.x | ✅ via HA Matter Server | ❌ | ❌ |
| Funziona **solo locale** (no cloud) | ✅ | ✅ | dipende | n/a |
| Sforzo di setup | Install + IP/PIN | Stack HA completo richiesto | Gia installata | n/a |
| Zone, luci, tapparelle, termostati, sensori | ✅ tutto in uno | ✅ (community/HACS, se esiste) | ✅ (solo UI Ksenia) | n/a |
| Gestione termostati ottimizzata per Matter (echo guard, recovery endpoint) | ✅ | parziale | n/a | n/a |
| Bridge MQTT integrato | ✅ opzionale | tramite HA | ❌ | n/a |
| Aggiornamenti real-time (WebSocket) | ✅ | ✅ | ✅ | n/a |
| Import backup `.ksa` per routing e mappatura stanze | ✅ | ❌ | n/a | n/a |
| Mantenuto, in sviluppo attivo | ✅ | community | vendor | n/a |
| Open source | ✅ MIT | ✅ | ❌ | n/a |

Se usi gia Home Assistant, entrambe le opzioni sono valide; questo plugin e la strada piu semplice se il tuo hub e gia Homebridge.

### Supporto Matter

Con **Homebridge 2.x**, ogni accessorio Lares4 esposto da questo plugin e automaticamente raggiungibile via Matter — le stesse luci, tapparelle, termostati e sensori che compaiono nell'app Casa funzionano anche in **Google Home**, **Amazon Alexa** e **Samsung SmartThings**, tutto sulla rete locale.

Il plugin include codice di affidabilita specifico per Matter, testato in installazioni reali:

- **Echo guard sui termostati** — sopprime gli aggiornamenti spuri di ritorno dai controller Matter, evitando che temperature impostate e modalita "ballino".
- **Recovery degli endpoint stale** — quando un endpoint Matter diventa stale dopo il riavvio di un controller, il plugin lo rileva e lo ricostruisce invece di lasciare un accessorio fantasma.
- **Mapping modalita/temperature** pensato per i cluster Matter (heat/cool/auto, range setpoint) cosi i comandi da qualsiasi ecosistema arrivano correttamente alla centrale.

Non serve nessuna configurazione aggiuntiva: abilita Matter in Homebridge e abbina il bridge all'ecosistema preferito.

### Compatibilita

Testato con centrali **Ksenia Lares 4.0** (firmware che espone il sottoprotocollo WebSocket `KS_WSOCK` sull'IP locale del pannello, con PIN di sistema valido). Se il tuo modello specifico Lares 4.0 funziona o ha problemi, apri una issue cosi possiamo ampliare la lista di compatibilita.

Richiede Homebridge `>= 1.6.0` (compatibile anche con la linea 2.x beta) e Node.js `>= 20`. **Il supporto Matter richiede Homebridge 2.x.**

Se questo plugin ti fa risparmiare tempo, lascia una ⭐ al repo — aiuta davvero altri a trovarlo.

### Caratteristiche

- **Zone di Sicurezza**: Sensori di contatto per porte e finestre
- **Controllo Luci**: Accensione/spegnimento di tutte le luci del sistema
- **Tapparelle Intelligenti**: Controllo percentuale con timing configurabile
- **Termostati**: Controllo temperatura e modalita riscaldamento/raffreddamento
- **Sensori Ambientali**: Temperatura, umidita e luminosita in tempo reale
- **Sensori Temperatura Sistema**: Temperatura interna ed esterna dalla centrale
- **Aggiornamenti Real-time**: Connessione WebSocket con riconnessione automatica
- **Supporto Matter**: Esposizione automatica via Matter su Homebridge 2.x (Google Home, Alexa, SmartThings)
- **Configurazione UI**: Interfaccia grafica completa in Homebridge UI
- **Personalizzazione**: Nomi personalizzati ed esclusione selettiva di entita
- **Bridge MQTT**: Pubblicazione stati e ricezione comandi via MQTT (opzionale)

### Prerequisiti

- Homebridge >= 1.6.0 (Homebridge 2.x richiesto per Matter)
- Node.js >= 20.0.0
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
| `logLevel`          | number   | 1            | 0=minimal, 1=normal, 2=debug    |
| `domusThermostat`   | object   | default attivi | Mapping termostati DOMUS, override manuali e fallback freshness |
| `ksaImport`         | object   | disabilitato | Import metadata da backup KSA per routing termostati, room mapping e apply opzionale |
| `debug`             | boolean  | false        | Logging dettagliato             |
| `telemetry`         | boolean  | true         | Segnalazione anonima errori     |
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
- **Modalita**: Off/Heat/Cool/Auto
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

- **Luci**: `homebridge/klares4/light/{slug}/state`
- **Tapparelle**: `homebridge/klares4/cover/{slug}/state`
- **Termostati**: `homebridge/klares4/thermostat/{slug}/state`
- **Sensori**: `homebridge/klares4/sensor/{slug}/state`
- **Zone**: `homebridge/klares4/zone/{slug}/state`
- **Scenari**: `homebridge/klares4/scenario/{slug}/state`

#### Ricezione Comandi

Invia comandi agli accessori sui seguenti topic:

- **Luci**: `homebridge/klares4/light/{device_id_or_slug}/set`
- **Tapparelle**: `homebridge/klares4/cover/{device_id_or_slug}/set`
- **Termostati**: `homebridge/klares4/thermostat/{device_id_or_slug}/set`
- **Scenari**: `homebridge/klares4/scenario/{device_id_or_slug}/set`

Esempi di ID canonici: `light_1`, `cover_2`, `thermostat_3`, `scenario_4`.

#### Esempi di Utilizzo

##### Accendere una luce:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/light/light_1/set" -m '{"on": true, "brightness": 80}'
```

##### Muovere una tapparella:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/cover/cover_2/set" -m '{"position": 50}'
```

##### Impostare temperatura termostato:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/thermostat/thermostat_3/set" -m '{"targetTemperature": 22, "mode": "heat"}'
```

##### Attivare uno scenario:

```bash
mosquitto_pub -h 192.168.1.100 -t "homebridge/klares4/scenario/scenario_4/set" -m '{"active": true}'
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

#### Telemetry

Di default, il plugin segnala anonimamente gli errori tecnici allo sviluppatore tramite Sentry. Questo aiuta a identificare e risolvere i bug più velocemente. Una rigida sanitizzazione garantisce che PIN, IP della centrale, token, IP del client, configurazione e nomi personalizzati dei dispositivi non vengano **mai** trasmessi.
Se preferisci non inviare segnalazioni di errore, puoi disattivare la funzione aggiungendo:

```json
{
	"telemetry": false
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

#### Pianificato per v1.2.0

I seguenti tipi di entità non sono attualmente supportati ma sono pianificati per una futura release:

##### Sistemi di Irrigazione (IRR)

- **Tipo**: Switch (bistabile)
- **Esempi**: Irrigazione a goccia, zone giardino, irrigatori
- **Mappatura HomeKit**: Accessori Valve/Switch
- **Stato**: Pianificato

##### Indicatori e LED di Stato (GEN, MOD:S)

- **Tipo**: Sensori/switch in sola lettura
- **Esempi**: Spie stato zone, LED di sistema
- **Mappatura HomeKit**: Sensore di contatto (sola lettura)
- **Stato**: Pianificato

##### Sirene e Allarmi (GEN, MOD:AT)

- **Tipo**: Switch (controllo manuale)
- **Esempi**: Sirena esterna, sirena interna
- **Mappatura HomeKit**: Switch con considerazioni di sicurezza
- **Stato**: In valutazione

##### Ponti Allarme (GEN, MOD:A)

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
