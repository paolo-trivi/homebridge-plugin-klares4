# Protocollo WebSocket

## Trasporto e Sessione

- Endpoint:
  - HTTPS WSS: `wss://<ip>:443/KseniaWsock/`
  - HTTP WS: `ws://<ip>:80/KseniaWsock/`
- Login: `CMD=LOGIN`, `PAYLOAD_TYPE=UNKNOWN`, con `PIN`.
- Su `LOGIN_RES` OK, il plugin salva `ID_LOGIN` e avvia letture iniziali.

## Pipeline di Lettura Iniziale

Il plugin invia:

1. `READ/ZONES`
2. `READ/MULTI_TYPES` (`OUTPUTS`, `BUS_HAS`, `SCENARIOS`)
3. `READ/STATUS_OUTPUTS`
4. `READ/STATUS_BUS_HA_SENSORS`
5. `READ/STATUS_SYSTEM`
6. `READ/PRG_THERMOSTATS`
7. `READ/CFG_THERMOSTATS`
8. `REALTIME/REGISTER` con:
   - `STATUS_ZONES`
   - `STATUS_OUTPUTS`
   - `STATUS_BUS_HA_SENSORS`
   - `STATUS_SYSTEM`
   - `STATUS_TEMPERATURES`
   - `SCENARIOS`

## Routing Messaggi

- `ProtocolRouter` smista per `CMD` e `PAYLOAD_TYPE`.
- `READ_RES` aggiorna discovery e cache runtime.
- `REALTIME_RES/REGISTER_ACK` e `REALTIME/CHANGES` aggiornano stati live.
- `CommandDispatcher` gestisce ACK attesi e timeout.

## Path Comandi

- Luci/tapparelle/cancelli:
  - `CMD_USR/CMD_SET_OUTPUT`
- Scenari:
  - `CMD_USR/CMD_EXE_SCENARIO`
- Termostati:
  - `WRITE_CFG/CFG_ALL` con `CFG_THERMOSTATS`
  - ACK atteso: `WRITE_CFG_RES`

Il fallback legacy `WRITE/THERMOSTAT` non e usato.

## Payload Termostati

### `CFG_THERMOSTATS`

Config persistente, usata per:

- allineamento startup mode/target
- scritture non distruttive (merge con entry esistente)

### `STATUS_TEMPERATURES`

Fonte autorevole realtime per:

- temperatura corrente
- target (se numerico valido)
- mode HVAC
- stato output attivo/inattivo

### `STATUS_OUTPUTS`

Stato output fisico. Per termostati e secondario (correlazione activity), non autorita per routing comandi.

### `PRG_THERMOSTATS`

Mappa strutturale (se firmware la espone):

- ID termostato configurazione
- sensore Domus associato (`PERIPH.PID`)
- output riscaldamento/raffrescamento

Usata per routing affidabile senza euristiche.
