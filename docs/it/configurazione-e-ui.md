# Configurazione e UI

## Campi Base Obbligatori

- `ip`
- `pin`
- opzionali `port`, `https`, `allowInsecureTls`

Lascia `port` vuota: il plugin usa 443 con `https` (il default) e 80 senza. Una `port` esplicita viene sempre usata cosi com'e, quindi `https: false` con `port: 443` non si connette.

## Affidabilita e Logging

- `logLevel`:
  - `0` minimal
  - `1` normal
  - `2` debug
- `commandTimeoutMs`
- `reconnectInterval`
- `heartbeatInterval`

Il vecchio `debug: true` vale solo se `logLevel` manca. La UI Homebridge scrive al salvataggio tutti i default di primo livello, compreso `logLevel: 1`, quindi per il log di debug usa `logLevel: 2`.

## Blocco Domus Termostati

`domusThermostat`:

- `enabled`
- `sensorFreshnessMs`
- `manualPairs` (`output -> sensore Domus`)
- `manualCommandPairs` (`output -> cfg thermostat ID`), array di `{ thermostatOutputId, commandThermostatId }`; scritto dall'import KSA e modificabile dalla UI

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
- Se `applyAtStartup=true`, i blocchi selezionati vengono persistiti in `config.json` e il flag torna `false`. `config.json` viene riscritto in modo atomico (file temporaneo + rename) e mantiene la sua formattazione.

Cosa fa ogni blocco, a runtime e quando viene persistito:

- `applyDomusMappings` (attivo di default): imposta `domusThermostat.manualPairs` e `manualCommandPairs` dal backup.
- `applyRoomMapping` (attivo di default): i nomi delle stanze della centrale diventano slug sicuri per MQTT (`Sala / Pranzo` diventa `sala_pranzo`). Le stanze della centrale vengono usate solo se non hai definito nessuna stanza; le tue stanze non vengono mai sostituite. L'import non attiva mai `roomMapping.enabled`, perche cambierebbe tutti i topic MQTT: attivalo tu.
- `applyCustomNames`: i nomi della centrale vengono aggiunti per dispositivo; un dispositivo a cui hai gia dato un nome mantiene il tuo. Il risultato e scritto nella forma array.
- `applyExclusionSuggestions`: gli ID suggeriti vengono aggiunti alle tue liste `exclude*` senza mai sostituirle (oggi il parser non ne suggerisce nessuno).
- Un `klares4-ksa-cache.json` non valido o incompleto viene ignorato con un warning; riesegui l'import per ricostruirlo.

## Visibilita Device e Naming

- `excludeOutputs`
- `excludeZones`
- `excludeSensors`
- `excludeScenarios`

Le liste di esclusione vogliono l'ID numerico senza prefisso (`37` per `light_37`, `5` per `zone_5`). Un ID di sensore DOMUS nasconde tutte e tre le sue letture; le temperature della centrale si escludono con `sensor_system_temp_in` / `sensor_system_temp_out`. Il sommario di avvio stampa sia l'ID del dispositivo sia il valore da usare qui (`exclude:`).

Scenari di allarme:

- Gli scenari che inseriscono o disinseriscono l'allarme (ARM/DISARM) non vengono mai esposti.
- `exposePartialArmScenarios` (boolean, default `false`): con `false` gli scenari di categoria `PARTIAL` (inserimento parziale) non vengono esposti a HomeKit, Matter o MQTT e non possono essere attivati. Impostalo a `true` solo se accetti che chiunque possa azionare l'interruttore (assistenti vocali, scene, automazioni, MQTT) possa inserire parzialmente l'allarme senza che venga chiesto il PIN.
- `customNames` rinomina i dispositivi per HomeKit, MQTT e Matter; usa la forma array (`{ deviceId, name }`, per esempio `light_18`, `zone_3`, `sensor_1`, oppure `sensor_system_temp_in`, il cui nome e usato cosi com'e), che la UI Homebridge conserva — la vecchia mappa per categoria viene ancora letta ma cancellata quando la UI riscrive config.json. Un import KSA con `applyCustomNames` scrive la forma array
- `matterExposure` nasconde intere categorie soltanto da Matter
- `matterOverrides` applica `name` / `exposed` solo su Matter; usa la forma array (`{ deviceId, name, exposed }`), che la UI Homebridge conserva — una mappa per device ID viene cancellata quando la UI riscrive config.json
- `matterRecoveryRequests` e un array di `{ deviceId, generation }`: un ID `thermostat_*` e una generazione positiva che puo solo crescere. Le righe senza `deviceId` o senza una `generation` valida vengono ignorate (con gli schemi precedenti la UI scriveva a ogni salvataggio una riga vuota `{ "generation": 1 }`; e innocua)
- `matterUnregisterTimeoutMs` (default 3000, 500-30000): quanto il plugin attende che un endpoint Matter rimosso sparisca davvero, prima di rinunciare e mantenere il nome attuale

La precedenza dell'esposizione e: esclusione globale, override per device, categoria, quindi default esistente (`true`). Gli override Matter non cambiano HAP/HomeKit o MQTT. Nella UI la casella "Esposto su Matter" di ogni riga e selezionata di default: deselezionala per nascondere il dispositivo; una riga selezionata mantiene esposto il dispositivo anche se la sua categoria e disattivata. Un salvataggio dalla UI con la 2.2.0-rc.3 o precedenti scriveva `exposed: false` su tutte le righe; ora il plugin elenca i dispositivi nascosti in un warning all'avvio.

La generazione di recovery viene consumata una sola volta e persistita prima della modifica topologica. Incrementala soltanto per un nuovo tentativo deliberato. Se la recovery fallisce o viene interrotta, il plugin torna al fallback TemperatureSensor; non cancellare lo store fallback.

## Room Mapping

- `roomMapping.enabled`
- `roomMapping.rooms[]`
- ogni stanza contiene `roomName` e `devices[].deviceId`

`roomName` deve rispettare `^[a-z0-9_]+$`: diventa un livello del topic MQTT.

L'import KSA puo generare le stanze da `PRG_ROOMS + PRG_MAPS` quando non ne hai (vedi sopra); trasforma i nomi della centrale in slug e lascia `enabled` come l'hai impostato.

## Telemetry

- `telemetry` (boolean, default: `true`)

La telemetry e attiva di default e invia segnalazioni anonime di errore tramite Sentry. Per disattivarla usa `telemetry: false`.

- Vengono inviati solo gli errori che il plugin stesso segnala in punti espliciti (oggi un avvio della piattaforma o un'inizializzazione della connessione falliti): tipo di errore, messaggio, stack trace, versione del plugin e una breve etichetta di contesto.
- Non c'e nessuna cattura globale di crash o eccezioni non gestite, e nessun dato di utilizzo o analytics.
- Ogni evento viene prima sanitizzato: PIN, IP/host della centrale e sender configurati, URL e indirizzi IPv4 vengono rimossi dal testo; campi come nomi, stanze, dispositivi, configurazione e payload vengono scartati. I percorsi negli stack frame vengono ridotti alla parte interna al plugin o a `node_modules` e la home directory viene sostituita da `~`; le segnalazioni usano un client Sentry privato, isolato dagli altri plugin nello stesso processo.
