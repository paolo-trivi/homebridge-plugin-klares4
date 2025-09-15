# homebridge-plugin-klares4

[![npm version](https://badge.fury.io/js/homebridge-plugin-klares4.svg)](https://badge.fury.io/js/homebridge-plugin-klares4)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Plugin completo per sistemi Ksenia Lares4 che integra zone di sicurezza, luci, tapparelle, termostati e sensori ambientali in un'unica soluzione per Homebridge.

## ✨ Caratteristiche

- 🔐 **Zone di Sicurezza**: Sensori di contatto per porte e finestre
- 💡 **Controllo Luci**: Accensione/spegnimento di tutte le luci del sistema
- 🪟 **Tapparelle Intelligenti**: Controllo percentuale con timing configurabile
- 🌡️ **Termostati**: Controllo temperatura e modalità riscaldamento/raffreddamento
- 📊 **Sensori Ambientali**: Temperatura, umidità e luminosità in tempo reale
- 🔄 **Aggiornamenti Real-time**: Connessione WebSocket con riconnessione automatica
- ⚙️ **Configurazione UI**: Interfaccia grafica completa in Homebridge UI
- 🎯 **Personalizzazione**: Nomi personalizzati ed esclusione selettiva di entità

## 📋 Prerequisiti

- Homebridge >= 1.6.0
- Node.js >= 14.18.1
- Sistema Ksenia Lares4 con accesso WebSocket abilitato

## 🚀 Installazione

### Tramite Homebridge UI (Consigliato)

1. Apri Homebridge UI
2. Vai su **Plugins**
3. Cerca `homebridge-plugin-klares4`
4. Clicca **Install**
5. Configura il plugin tramite l'interfaccia grafica

### Tramite npm

```bash
npm install -g homebridge-plugin-klares4
```

## ⚙️ Configurazione

### Configurazione Base

Il plugin può essere configurato completamente tramite l'interfaccia grafica di Homebridge UI. I parametri obbligatori sono:

- **Nome Plugin**: Nome che apparirà nei log
- **Indirizzo IP**: IP del sistema Ksenia Lares4
- **Sender ID**: Identificativo univoco per la connessione WebSocket
- **PIN Sistema**: PIN di accesso al sistema Lares4

### Configurazione Manuale (config.json)

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

### Parametri di Configurazione

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

## 🏠 Tipi di Accessori Supportati

### Zone di Sicurezza

- **Tipo HomeKit**: Contact Sensor
- **Stati**: Aperto/Chiuso, Bypass
- **Aggiornamenti**: Real-time via WebSocket

### Luci

- **Tipo HomeKit**: Lightbulb
- **Controllo**: On/Off
- **Feedback**: Stato real-time

### Tapparelle

- **Tipo HomeKit**: Window Covering
- **Controllo**: Percentuale (0-100%)
- **Comandi**: Su/Giù/Stop
- **Timing**: Configurabile tramite `maxSeconds`

### Termostati

- **Tipo HomeKit**: Thermostat
- **Modalità**: Off/Heat/Cool
- **Controllo**: Temperatura target
- **Sensori**: Temperatura corrente

### Sensori Ambientali

- **Tipi HomeKit**: Temperature/Humidity/Light Sensor
- **Dati**: Temperatura, Umidità, Luminosità
- **Aggiornamenti**: Real-time

## 🔧 Risoluzione Problemi

### Connessione WebSocket

Se il plugin non riesce a connettersi:

1. Verifica che l'IP sia corretto
2. Controlla che il PIN sia valido
3. Assicurati che il sistema Lares4 accetti connessioni WebSocket
4. Verifica che la porta 443 (HTTPS) o 80 (HTTP) sia accessibile

### Debug

Abilita il debug logging per diagnosi dettagliate:

```json
{
	"debug": true
}
```

### Serial Number Warning

Il warning "Serial Number characteristic must have a length of more than 1 character" è stato risolto nelle versioni recenti. Assicurati di avere l'ultima versione del plugin.

### Tapparelle non Responsive

Se le tapparelle non rispondono correttamente:

1. Verifica il parametro `maxSeconds`
2. Controlla che i comandi up, down, alt siano supportati dal sistema
3. Testa prima con movimenti completi (0% o 100%)

## 📊 Monitoraggio

Il plugin fornisce log dettagliati per monitorare:

- Stato connessione WebSocket
- Comandi inviati e ricevuti
- Aggiornamenti entità
- Errori e riconnessioni

## 🤝 Contributi

I contributi sono benvenuti! Per contribuire:

1. Fork del repository
2. Crea un branch per la tua feature
3. Commit delle modifiche
4. Push al branch
5. Apri una Pull Request

## 📄 Licenza

Questo progetto è rilasciato sotto licenza MIT.

## 🔗 Link Utili

- [Homebridge](https://homebridge.io/)
- [Homebridge UI](https://github.com/homebridge/homebridge-config-ui-x)
- [Ksenia Security](https://www.ksenia.it/)

---

**Nota**: Questo progetto non è affiliato con Ksenia Security S.p.A. È un progetto open source sviluppato dalla comunità.
