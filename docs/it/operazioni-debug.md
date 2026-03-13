# Operativita e Debug

## Checklist Rapida

1. Imposta `logLevel=2`.
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
