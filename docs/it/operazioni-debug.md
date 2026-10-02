# Operativita e Debug

## Checklist Rapida

1. Imposta `logLevel=2` (il vecchio `debug: true` viene ignorato appena la UI Homebridge ha salvato `logLevel`).
2. Riavvia Homebridge e verifica:
   - `Response received: MULTI_TYPES`
   - `Response received: STATUS_OUTPUTS`
   - `Response received: CFG_THERMOSTATS`
   - register realtime con `STATUS_TEMPERATURES`
3. Esegui un comando termostato e verifica che cambi la stanza corretta in app Ksenia.

## Sintomi Comuni

### Il termostato cambia la stanza sbagliata

Probabile mismatch tra output e `CFG_THERMOSTATS.ID`.

Azioni:

- abilita `ksaImport` con `.ksa` valido
- controlla righe debug:
  - `thermostat_<output> => cfg:<id> domus:<id> source:<...>`
- riprova setpoint su/giu e cambio mode

### Stati non sincronizzati all'avvio

Azioni:

- verifica presenza `STATUS_TEMPERATURES` in register ACK / realtime changes
- verifica `CFG_THERMOSTATS` letto correttamente
- verifica assenza loop reconnect/login

### `PRG_THERMOSTATS` non disponibile

Alcuni firmware rispondono comando non disponibile.

Azioni:

- usa preload da cache KSA sanitizzata
- verifica presenza file cache in storage Homebridge

## File di Cattura Debug

- `generateDebugFile: true` registra il traffico WebSocket al prossimo avvio e scrive `klares4-debug-<timestamp>.json` nella cartella storage di Homebridge, con i PIN mascherati. Il flag torna da solo a `false` in `config.json`.
- `debugCaptureDurationMs` (default 60000, intervallo 10000-1800000) imposta la durata della cattura. Su installazioni solo Matter, dove Apple Casa impiega minuti a rispondere dopo il riavvio del child bridge, alzala a 300000-600000.
- Riproduci il problema dall'app Ksenia o da HomeKit mentre la cattura e in corso. Se Homebridge si ferma o si riavvia prima della fine, il file viene scritto allo spegnimento con quanto registrato fino a quel momento.

## Script Diagnostico

Disponibile nel repo:

- `scripts/debug-thermostat-routing.js`

Permette di vedere:

- ID usati nei payload write termostato
- payload `CFG_THERMOSTATS` e `STATUS_TEMPERATURES`
- convergenza post write in realtime

## Note Sicurezza

- Non committare backup `.ksa` raw (contengono dati sensibili).
- La cache plugin usa estrazione whitelist sanitizzata.
- Mantieni `allowInsecureTls=false` salvo necessita strettamente locale/fidata.
