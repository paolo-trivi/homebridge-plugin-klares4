# Panoramica Plugin

## Componenti Runtime

- `Lares4Platform`: orchestrazione Homebridge (`src/platform/index.ts`)
- `KseniaWebSocketClient`: facade websocket (`src/websocket-client/index.ts`)
- `MqttBridge`: bridge MQTT opzionale (`src/mqtt-bridge/index.ts`)
- handler accessori HomeKit in `src/accessories/*`

## Sequenza Avvio

1. Homebridge invoca `didFinishLaunching`.
2. La piattaforma inizializza websocket e discovery.
3. Se abilitato, viene eseguito import KSA prima della connessione.
4. Login alla centrale e letture iniziali.
5. Discovery device e restore accessori da cache.
6. Registrazione realtime e allineamento stati.

## Modello Device

- Output mappati in:
  - `light_*`
  - `cover_*`
  - `gate_*`
  - `thermostat_*`
- Zone in `zone_*`.
- Scenari in `scenario_*`.
- Sensori ambientali Domus in:
  - `sensor_temp_*`
  - `sensor_hum_*`
  - `sensor_light_*`

## Principi Funzionali

- I payload realtime (`STATUS_*`) hanno priorita sulle assunzioni statiche.
- I termostati scrivono solo via `WRITE_CFG/CFG_ALL`.
- Il routing comandi usa mapping esplicito e cache, non euristiche deboli.
- Telemetria Domus stanza e routing comando termostato sono separati.

## Fonti Dati Interne

- `MULTI_TYPES`: metadata discovery output/scenari/sensori
- `STATUS_OUTPUTS`: stati runtime output
- `STATUS_BUS_HA_SENSORS`: telemetria stanza Domus
- `STATUS_SYSTEM`: temperature sistema (fallback)
- `CFG_THERMOSTATS`: configurazione persistente termostati
- `STATUS_TEMPERATURES`: stato operativo realtime termostati
- `PRG_THERMOSTATS` (se disponibile): mapping strutturale output/cfg/sensore

## Integrazione KSA

- `ksaImport` estrae da `.ksa`:
  - mapping comando termostati (`output -> cfg ID`)
  - mapping sensori stanza (`output -> sensor ID`)
  - room mapping e nomi opzionali
- Scrive cache sanitizzata:
  - `klares4-ksa-cache.json`
- Il runtime puo usare la cache anche se `PRG_THERMOSTATS` non e disponibile in WSS.
