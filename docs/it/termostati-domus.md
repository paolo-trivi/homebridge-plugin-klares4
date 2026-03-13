# Termostati Domus e KSA

## Problema

In molti impianti non c'e allineamento numerico tra:

- ID output termostato (`thermostat_20`, `thermostat_21`, ...)
- ID sensore Domus (`sensor_3`, `sensor_4`, ...)
- ID controllo termostato (`CFG_THERMOSTATS.ID` / `STATUS_TEMPERATURES.ID`)

Assumere `output == sensore == cfg` porta comandi sulla stanza sbagliata.

## Modello Corretto

Il plugin separa i namespace:

- Output: identita HomeKit (`thermostat_<outputId>`)
- Config termostato: ID di comando pannello
- Sensore Domus: telemetria stanza

## Priorita Risoluzione Command ID

1. `manualCommandPairs`
2. mapping live da `PRG_THERMOSTATS`
3. mapping cache sanitizzata da KSA
4. ID comando gia risolto in cache runtime
5. fallback degradato (`mappedDomusSensorId`, poi output ID)

## Autorita Stato Realtime

`STATUS_TEMPERATURES` governa:

- mode
- target
- activity HVAC

I sensori Domus restano utili per telemetria stanza, ma non decidono il routing comandi.

## Import KSA

`ksaImport` legge il backup `.ksa` e genera:

- `manualCommandPairs` (routing comandi)
- `manualPairs` (mapping stanza/sensore)
- room mapping e nomi opzionali

La persistenza plugin salva solo cache sanitizzata:

- `klares4-ksa-cache.json`

Il file `.ksa` raw non viene salvato dal plugin.

## Flusso Operativo Consigliato

1. `ksaImport.enabled=true` + `filePath`.
2. Riavvia Homebridge.
3. Verifica preview mapping nei log.
4. Imposta `ksaImport.applyAtStartup=true` per scrivere i blocchi selezionati in `config.json`.
5. Riavvia e valida i comandi termostato su app Ksenia.
