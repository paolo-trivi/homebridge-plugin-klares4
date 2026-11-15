# Configurazione e UI

L'elenco completo delle chiavi, con tipo, default e limiti, è la tabella del [README](../../README.md#parametri-di-configurazione). È generata dagli stessi dati di `config.schema.json` (il modulo delle impostazioni) e un test mantiene le due cose uguali. Questa pagina spiega come vengono letti i valori e come lavorano insieme i gruppi di opzioni.

## Come Vengono Letti i Valori

La configurazione grezza di Homebridge viene interpretata in un solo punto, all'avvio, e il resto del plugin vede soltanto il risultato validato.

- **Le opzioni on/off** richiedono un vero `true` o `false` JSON. Un'opzione con default `false` è attiva solo con `true`; una con default `true` è disattivata solo con `false`. Qualsiasi altro valore (`"true"`, `"false"`, `0`, `1`, un oggetto) viene ignorato, si applica il default sicuro e un warning indica la chiave e il tipo ricevuto. In particolare `"allowInsecureTls": "false"` mantiene attiva la verifica del certificato.
- **I numeri** devono essere numeri (interi dove la tabella dice intero). Un valore che non è un numero, non è finito o non è un intero torna al default; un valore fuori dai limiti viene portato al limite più vicino. I limiti sono quelli della tabella del README e del modulo delle impostazioni; il plugin li applica da solo, quindi un `config.json` modificato a mano non può farlo riconnettere centinaia di volte al secondo.
- **Le liste** devono essere liste. Un valore che non è una lista viene ignorato con un warning; una voce non valida per la sua lista viene scartata e nominata.
- **Le impostazioni per dispositivo sono array di oggetti** (`customNames`, `matterOverrides`, `matterRecoveryRequests`, `exposeOutputs`, `exposeScenarios`): la UI delle impostazioni di Homebridge ricostruisce `config.json` dal suo modulo e scarta in silenzio gli oggetti indicizzati per ID del dispositivo. La vecchia forma a mappa dei primi tre viene ancora letta e controllata come la forma array, ma non sopravvive a un salvataggio dalla UI.
- I problemi vengono segnalati **una sola volta all'avvio**, raggruppati in un unico warning (`Configuration: N value(s) ignored or adjusted`), e non stampano mai il PIN, la password MQTT o l'indirizzo della centrale. Un `pin` che non è né una stringa né un numero è un errore e il plugin non parte.
- Le chiavi rimosse dal plugin (`telemetry`, `ksaImport.applyExclusionSuggestions`) sono accettate in un `config.json` esistente e ignorate; cancellale quando ti è comodo.

Dopo la prima sincronizzazione un warning elenca le voci di `matterOverrides`, `matterRecoveryRequests` e `customNames` che non corrispondono a nessun dispositivo della centrale, con un suggerimento quando l'ID è solo un numero (`1` invece di `zone_1`) o è in maiuscolo.

### Forme degli ID dei dispositivi

| Dove | Accettato |
|---|---|
| `customNames`, `matterOverrides`, `matterRecoveryRequests` | ID dei dispositivi: `zone_1`, `light_5`, `cover_7`, `gate_9`, `thermostat_18`, `scenario_2`, `sensor_temp_3`, `sensor_hum_3`, `sensor_light_3` e `sensor_system_temp_in` / `sensor_system_temp_out`. `customNames` accetta anche `sensor_<id>` per tutte e tre le letture di un sensore DOMUS |
| `excludeZones`, `excludeOutputs`, `excludeSensors`, `excludeScenarios` | Un numero semplice (`5`, `"5"`, `" 5"`) o l'ID completo del dispositivo (`"gate_5"`, `"light_5"`, `"zone_3"`, `"scenario_2"`, `"sensor_temp_1"`); i sensori propri della centrale sono `sensor_system_temp_in` / `sensor_system_temp_out`. Il confronto è esatto |
| `exposeOutputs[].outputId`, `exposeScenarios[].scenarioId` | L'ID numerico della centrale (`"12"`); funzionano anche `light_12`, `output_12` e `scenario_4` |

Il riepilogo di avvio stampa, per ogni dispositivo, sia il suo ID sia il valore da usare nelle liste `exclude*` (`exclude:`).

## Connessione

- `ip` e `pin` sono obbligatori; `port`, `https`, `sender` e `allowInsecureTls` sono opzionali.
- Lascia `port` vuota: il plugin usa 443 con `https` (il default) e 80 senza. Una `port` esplicita viene usata così com'è, quindi `https: false` con `port: 443` non si connette.
- `allowInsecureTls` disattiva il controllo del certificato della centrale e consente la rinegoziazione TLS legacy di cui hanno bisogno la maggior parte delle centrali. È attivo solo con il valore JSON `true`. Usalo su una rete locale fidata, quando è il log a richiederlo.
- Il PIN è salvato in chiaro in `config.json`. Usa un utente dedicato della centrale.

## Affidabilità e Logging

- `reconnectInterval` è la base di un backoff esponenziale (tetto 60 s, con jitter). Riparte dopo una sincronizzazione completa.
- `heartbeatInterval` imposta il ping di keep-alive; una connessione senza risposta per due intervalli viene chiusa e i comandi in sospeso falliscono subito.
- `commandTimeoutMs` è l'attesa massima per la risposta della centrale a un comando, termostati inclusi. Un comando ancora in coda dopo questo tempo viene rifiutato.
- `logLevel` e `debug`: il livello `2` attiva la traccia dettagliata del plugin (comandi inviati alla centrale, dettagli di discovery e dei termostati). Quelle righe sono scritte al livello **debug** di Homebridge, quindi le vedi solo quando Homebridge gira in modalità debug (`-D`). I livelli `0` e `1` oggi si comportano allo stesso modo. `debug` è un interruttore legacy che aggiunge alcune righe di dettaglio allo stesso livello; sostituisce `logLevel: 2` solo quando `logLevel` è assente da `config.json`, cosa che la UI delle impostazioni non lascia mai accadere.

## Esposizione e Selezione

- Gli output di una categoria non riconosciuta e gli scenari di una categoria sconosciuta sono nascosti. `exposeOutputs` (`[{ outputId, exposeAs }]`, `exposeAs` è `light`) ed `exposeScenarios` (`[{ scenarioId }]`) abilitano i singoli dispositivi. Il log di avvio stampa le voci esatte. Dettagli nel README, [Politica di esposizione](../../README.md#politica-di-esposizione-fail-closed).
- `exposePartialArmScenarios` (default `false`): gli scenari di categoria `PARTIAL` non sono né esposti né eseguibili finché non lo attivi. `ARM` e `DISARM` non vengono mai esposti.
- `excludeOutputs`, `excludeZones`, `excludeSensors`, `excludeScenarios` rimuovono i dispositivi da HomeKit, Matter **e MQTT** (lo stato di un dispositivo non viene pubblicato e il dispositivo non può essere comandato). L'ID di un sensore DOMUS nasconde tutte e tre le sue letture.
- `customNames` rinomina i dispositivi per HomeKit, MQTT e Matter. Un import KSA con `applyCustomNames` scrive la forma array.

## Impostazioni Matter

- `matterExposure` disattiva interi tipi solo su Matter.
- `matterOverrides` imposta per singolo dispositivo un `name` e/o un `exposed` validi solo per Matter. Nella UI delle impostazioni "Exposed on Matter" è selezionata di default: deselezionala per nascondere il dispositivo. Una riga selezionata mantiene il dispositivo esposto anche quando il suo tipo è disattivato in `matterExposure`.
- `matterRecoveryRequests` è un array di `{ deviceId, generation }`: un ID `thermostat_*` e una generazione di almeno 1 che può solo crescere. Le righe senza un `deviceId` o una `generation` validi vengono ignorate.
- `matterUnregisterTimeoutMs` (default 3000, 500-30000) è il tempo che il plugin attende perché un endpoint rimosso scompaia davvero.
- Precedenza dell'esposizione: liste di esclusione, poi `exposed` per dispositivo, poi il tipo in `matterExposure`, poi il default (esposto). Le impostazioni Matter non modificano mai HomeKit né MQTT.

Vedi [Matter](./matter.md).

## Impostazioni dei Termostati

- `temperatureDefaults` (`target`, `min`, `max`, `step`) imposta l'intervallo e il passo del termostato HomeKit (HAP) e l'intervallo che i setpoint MQTT devono rispettare. I termostati Matter usano intervalli fissi (riscaldamento 5-30 °C, raffrescamento 16-35 °C). `step` è 0.5 o 1.
- `maxSeconds` e `coverStepSize` valgono solo per le tapparelle HomeKit; su Matter la tapparella mostra la posizione comunicata dalla centrale.
- `domusThermostat.enabled`, `sensorFreshnessMs`, `manualPairs` e `manualCommandPairs`: vedi [Termostati Domus e KSA](./termostati-domus.md).

## Blocco Import KSA

Opzioni di `ksaImport`: `enabled`, `filePath` (percorso assoluto del `.ksa`), `applyAtStartup`, `applyDomusMappings`, `applyRoomMapping`, `applyCustomNames`.

Comportamento:

- All'avvio, se abilitato e il file esiste, il plugin analizza il `.ksa`, registra un'anteprima riepilogativa, applica in memoria gli override di runtime e scrive la cache sanitizzata.
- Con `applyAtStartup: true`, le sezioni selezionate vengono salvate in `config.json` e il flag torna a `false`. `config.json` viene riscritto in modo atomico, mantiene la sua formattazione e, se è un link simbolico, resta tale.
- Se la scrittura non può avvenire, il plugin lo segnala, lascia i flag com'erano e riprova al prossimo avvio.
- Con più di un blocco `Lares4Complete` in `config.json`, viene aggiornato il blocco dell'istanza in esecuzione (individuato per `name`, poi per `ip`); se non è possibile distinguerli non viene scritto nulla e un warning spiega come risolvere.

Cosa fa ogni interruttore:

- `applyDomusMappings` (attivo di default): **aggiunge** le mappature dei termostati del backup che mancano. I `manualPairs` e `manualCommandPairs` che hai configurato vincono sempre, e un backup vuoto non svuota mai le tue liste. Quando una delle tue coppie differisce dal backup, una riga di log indica il termostato e entrambi i valori.
- `applyRoomMapping` (attivo di default): i nomi delle stanze della centrale diventano slug sicuri per MQTT (`Living / Dining` diventa `living_dining`). Vengono usati solo quando non hai definito nessuna stanza. L'import non attiva mai `roomMapping.enabled`, perché cambia tutti i topic MQTT.
- `applyCustomNames`: i nomi della centrale vengono aggiunti per dispositivo; un dispositivo che hai già rinominato mantiene il tuo nome. Il risultato è scritto nella forma array.
- Un `klares4-ksa-cache.json` non valido o incompleto viene ignorato con un warning; esegui di nuovo l'import per ricostruirlo.

## Room Mapping

- `roomMapping.enabled` e `roomMapping.rooms[]`; ogni stanza ha `roomName` e `devices[].deviceId`.
- `roomName` deve rispettare `^[a-z0-9_]+$`: diventa un livello del topic MQTT.
- Con il room mapping attivo, un comando su `<prefix>/<room>/<type>/<id>/set` viene eseguito solo per un dispositivo di quella stanza.
- L'import KSA può generare le stanze dalla centrale quando non ne hai; non attiva mai `enabled`.

## Modulo delle Impostazioni (UI di Homebridge)

- Il modulo è in inglese. Il suo layout raggiunge ogni chiave dello schema, compresi i campi dentro le liste, perché la UI cancella qualsiasi chiave che non sa mostrare al salvataggio successivo.
- Gli array di oggetti (nomi, override, abilitazioni, coppie, stanze) hanno una riga per voce; la riga vuota che la UI aggiunge viene ignorata.
- `showAdvanced` sblocca soltanto i parametri avanzati nel modulo; il plugin lo ignora.
