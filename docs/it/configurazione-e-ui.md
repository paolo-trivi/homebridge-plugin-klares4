# Configurazione e UI

## Campi Base Obbligatori

- `ip`
- `pin`
- opzionali `port`, `https`, `allowInsecureTls`

## Affidabilita e Logging

- `logLevel`:
  - `0` minimal
  - `1` normal
  - `2` debug
- `commandTimeoutMs`
- `reconnectInterval`
- `heartbeatInterval`

## Blocco Domus Termostati

`domusThermostat`:

- `enabled`
- `sensorFreshnessMs`
- `manualPairs` (`output -> sensore Domus`)
- `manualCommandPairs` (`output -> cfg thermostat ID`)

## Blocco Import KSA

`ksaImport`:

- `enabled`
- `filePath` (path assoluto `.ksa`)
- `applyAtStartup`
- `applyDomusMappings`
- `applyRoomMapping`
- `applyCustomNames`
- `applyExclusionSuggestions`

Comportamento:

- Se attivo e file presente, a startup:
  - parse `.ksa`
  - preview summary nei log
  - apply runtime in memoria
  - salvataggio cache sanitizzata
- Se `applyAtStartup=true`, i blocchi selezionati vengono persistiti in `config.json` e il flag torna `false`.

## Visibilita Device e Naming

- `excludeOutputs`
- `excludeZones`
- `excludeSensors`
- `excludeScenarios`
- `customNames` rinomina i dispositivi per HomeKit, MQTT e Matter; usa la forma array (`{ deviceId, name }`, per esempio `light_18`, `zone_3`, `sensor_1`), che la UI Homebridge conserva — la vecchia mappa per categoria viene ancora letta ma cancellata quando la UI riscrive config.json. Un import KSA con `applyCustomNames` scrive la forma array
- `matterExposure` nasconde intere categorie soltanto da Matter
- `matterOverrides` applica `name` / `exposed` solo su Matter; usa la forma array (`{ deviceId, name, exposed }`), che la UI Homebridge conserva — una mappa per device ID viene cancellata quando la UI riscrive config.json
- `matterRecoveryRequests` associa un ID `thermostat_*` a una generazione positiva monotona

La precedenza dell'esposizione e: esclusione globale, override per device, categoria, quindi default esistente (`true`). Gli override Matter non cambiano HAP/HomeKit o MQTT. Nella UI la casella "Esposto su Matter" di ogni riga e selezionata di default: deselezionala per nascondere il dispositivo; una riga selezionata mantiene esposto il dispositivo anche se la sua categoria e disattivata. Un salvataggio dalla UI con la 2.2.0-rc.3 o precedenti scriveva `exposed: false` su tutte le righe; ora il plugin elenca i dispositivi nascosti in un warning all'avvio.

La generazione di recovery viene consumata una sola volta e persistita prima della modifica topologica. Incrementala soltanto per un nuovo tentativo deliberato. Se la recovery fallisce o viene interrotta, il plugin torna al fallback TemperatureSensor; non cancellare lo store fallback.

## Room Mapping

- `roomMapping.enabled`
- `roomMapping.rooms[]`
- ogni stanza contiene `roomName` e `devices[].deviceId`

L'import KSA puo generare room mapping da `PRG_ROOMS + PRG_MAPS`.

## Telemetry

- `telemetry` (boolean, default: `true`)

Il plugin raccoglie automaticamente e in forma anonima gli errori tecnici (crash, eccezioni non gestite) tramite Sentry per facilitare l'identificazione e la risoluzione dei bug.
La funzione applica una sanitizzazione molto stretta prima dell'invio: non vengono MAI trasmessi il PIN, l'IP della centrale, URL, token, IP client, configurazioni, o nomi scelti per i dispositivi.
Se preferisci non inviare alcuna segnalazione di errore, puoi disattivare la funzione impostando `telemetry: false` nella configurazione.
