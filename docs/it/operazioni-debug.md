# Operazioni e risoluzione problemi

## Checklist di validazione rapida

1. Imposta **Log Level** su `2` ed esegui Homebridge in modalità debug (`-D`): le righe dettagliate vengono scritte al livello debug di Homebridge, quindi Homebridge le mostra solo in modalità debug. I livelli `0` e `1` per ora si comportano allo stesso modo.
2. Riavvia Homebridge e verifica:
   - `Response received: MULTI_TYPES`
   - `Response received: STATUS_OUTPUTS`
   - `Response received: CFG_THERMOSTATS`
   - la registrazione realtime con `STATUS_TEMPERATURES`
   - un riepilogo dei dispositivi, e nessun avviso `Configuration: ... value(s) ignored or adjusted`
3. Verifica un comando termostato e controlla nell'app Ksenia che cambi la stanza giusta.

## Messaggi all'avvio

| Messaggio | Significato e azione |
|---|---|
| `Exposure policy: N device(s) of a category the plugin does not recognize are not exposed ...` | Uscite o scenari nascosti dalla politica fail-closed. Il messaggio li elenca e termina con le righe esatte `exposeOutputs` / `exposeScenarios`. Aggiungi solo ciò che è sicuro da azionare da assistenti vocali, scene e automazioni, poi riavvia. **"Un'uscita o uno scenario è sparito dopo l'aggiornamento alla 2.3.0"**: è per questo |
| `Exposure policy: these opt-in entries have no effect` | Una riga di `exposeOutputs` o `exposeScenarios` indica qualcosa di già riconosciuto, o qualcosa che la centrale non elenca |
| `Exposed scenarios the panel flags with a PIN requirement` | Verifica che l'esecuzione di quegli scenari senza codice sia voluta |
| `Configuration: N value(s) ignored or adjusted (fix them in the plugin settings)` | Un valore ha il tipo sbagliato o è fuori intervallo; ogni riga indica la chiave. Correggilo nelle impostazioni; nel frattempo si applica il default sicuro |
| `Invalid configuration, pin: must be a string or a number` | Il PIN ha un tipo sbagliato: il plugin non si avvia |
| `Configuration: these entries match no device discovered on the panel ...` | Una voce di `matterOverrides`, `matterRecoveryRequests` o `customNames` indica un dispositivo che la centrale non ha. Un suggerimento segnala quando l'ID è solo un numero (`1` invece di `zone_1`) o è in maiuscolo |
| `[Matter] matterOverrides hides N device(s) from Matter: ...` | Scritto dopo la prima sincronizzazione; conta solo i dispositivi che la centrale ha davvero riportato. Se non hai deselezionato tu stesso "Exposed on Matter", selezionalo di nuovo nelle impostazioni del plugin |
| `HomeKit (HAP) limit reached: a Homebridge bridge holds at most 149 accessories ...` | I dispositivi oltre il limite restano su Matter e MQTT. Usa le liste `exclude*` o un child bridge |
| `KSA import: keeping your domusThermostat.manualCommandPairs entry for thermostat_N ...` (info) | La tua coppia è diversa dal backup; non c'è nulla da fare a meno che la centrale sia stata riprogrammata |
| `KSA import was applied for this run but could not be saved to config.json` | L'importazione gira di nuovo al prossimo avvio; controlla che `config.json` sia scrivibile |
| `config.json could not be replaced atomically (EBUSY); rewriting it in place` | Tipico con un bind mount Docker di un singolo file; monta invece la directory di Homebridge |
| `config.json has N "Lares4Complete" blocks and none can be told apart as this instance` | Tieni un solo blocco, oppure dai a ciascuno un `name` distinto |
| `KSA file is too large (X MB; the limit is 32 MB)` | Il file `.ksa` viene rifiutato |
| `Skipping cache handler init for X: missing or malformed device context` | Un accessorio in cache danneggiato viene saltato (e riallineato alla prossima scoperta); gli altri vengono ripristinati |
| `error reporting was removed in 2.3.0; the telemetry key is ignored` | Elimina `telemetry` da `config.json` quando ti è comodo |

## Messaggi di connessione

| Messaggio | Significato e azione |
|---|---|
| `The panel refused or did not answer the login N times in a row ... one attempt every 60 min` | Controlla il PIN e che l'utente sia abilitato sulla centrale. Il plugin riprova una volta all'ora; riavvia Homebridge dopo aver corretto il PIN per riconnetterti subito |
| `The panel refused the <TYPE> read (...)` | Una lettura di scoperta (`ZONES`, `MULTI_TYPES`) fa fallire la sincronizzazione e il plugin si riconnette con backoff; una lettura di stato o termostato rifiutata viene registrata e la sincronizzazione continua |
| `The panel refused the realtime registration (...)` / `The panel did not complete the synchronization within 60s` | La sessione viene chiusa e ritentata con backoff |
| `<...> frame with a wrong CRC_16: dropped (N frame(s) dropped in this session so far)` | Un frame corrotto. Se sono frequenti: controlla il percorso di rete. Se i frame con nomi accentati vengono sempre scartati, segnalalo |
| `Zone status field X reported "Y", a value not observed before` | Informativo: un nuovo valore di un campo di zona, registrato una sola volta |

## Messaggi di comando

| Messaggio | Significato |
|---|---|
| `Command for gate_N not sent: a previous command for it is still in progress` | Premere di nuovo mentre un impulso attende la centrale viene rifiutato (cancelli, scenari) |
| `... replaced by a newer command` | Luci, dimmer, tapparelle: viene inviato solo l'ultimo comando in coda |
| `... still queued after N ms` | Il comando ha atteso più di `commandTimeoutMs` ed è stato rifiutato invece di essere inviato in ritardo |
| `Command refused: X is not a light discovered on the panel` | Il dispositivo non è (o non è ancora) un dispositivo scoperto di quel tipo: nascosto dalla politica di esposizione, oppure la prima sincronizzazione non è terminata |
| `cfg id X (from ...) could not be read from the panel; write refused` | Una scrittura su termostato è stata rifiutata perché non è stato possibile stabilirne l'instradamento. Correggi `domusThermostat.manualCommandPairs` |
| `... is not the heating or cooling output of any PRG_THERMOSTATS program` | L'uscita del termostato non appartiene a nessun programma su una centrale che ha programmi |
| `... does not match what this thermostat reports in realtime` | Un instradamento ipotizzato è stato rifiutato perché incoerente; aggiungi la riga `manualCommandPairs` che l'errore mostra |
| `Thermostat realtime mode ACT_MODEL=... is not known to the plugin` | Segnala il valore in una issue; nel frattempo il termostato viene mostrato come riscaldamento o raffrescamento |

## Sintomi comuni

### Il termostato cambia la stanza sbagliata

Un mismatch di instradamento tra l'uscita e l'ID del termostato della centrale. Abilita `ksaImport` con un `.ksa` valido, oppure imposta `manualCommandPairs`. Con il logging di debug cerca `thermostat_<output> => cfg:<id> domus:<id> source:<...>`. Il plugin rifiuta le scritture che non sa instradare (vedi sopra), quindi ora dovrebbe fallire con un errore invece di cambiare un'altra stanza.

### Gli stati all'avvio non si sincronizzano

Verifica che `STATUS_TEMPERATURES` sia nella registrazione realtime e che cambi, che la lettura di `CFG_THERMOSTATS` sia riuscita e che non ci siano cicli ripetuti di riconnessione o login.

### `PRG_THERMOSTATS` non disponibile

Alcuni firmware rispondono "command unavailable" a ogni login; è atteso e non viene segnalato. Affidati alla cache KSA sanificata (controlla che `klares4-ksa-cache.json` esista nella cartella di storage di Homebridge) oppure a `manualCommandPairs`.

### Certificato self-signed o `unsafe legacy renegotiation disabled`

Le centrali Lares4 usano un certificato self-signed e molte richiedono la rinegoziazione TLS legacy, che le versioni attuali di Node.js rifiutano di default. Il log mostra un suggerimento che indica `allowInsecureTls`. Su una rete locale fidata, abilita `allowInsecureTls` e riavvia Homebridge; altrimenti, se la centrale lo consente, imposta `https: false` per usare `ws://` in chiaro.

### Un dispositivo manca o un sensore mostra "No Response"

Un dispositivo nascosto (categoria non riconosciuta: vedi la prima riga dei messaggi all'avvio), uno escluso, o un sensore che la centrale non ha ancora riportato (un DOMUS offline, per esempio) non mostra nulla oppure "No Response" invece di uno 0 °C inventato o di "nessun movimento".

### I consumer MQTT hanno perso un dispositivo

Controlla se c'è una collisione di nomi (il dispositivo si è spostato su `.../<type>/<device id>/state`), un'esclusione o un dispositivo nascosto, e `mqtt.commands: false` (solo i comandi sono disattivati, lo stato continua a fluire). Vedi [MQTT](./mqtt.md).

## File di debug

Attiva `generateDebugFile`, riavvia, riproduci il problema dall'app Ksenia o da HomeKit mentre la cattura è in corso, attendi il messaggio di fine cattura nel log e recupera `klares4-debug-<timestamp>.json` dalla cartella di storage di Homebridge. **Il file è riservato**: invialo in privato, mai in una issue pubblica. Vedi [Privacy e file di debug](./privacy-e-file-di-debug.md).

## Note di sicurezza

- Non committare mai backup `.ksa` grezzi o file di debug.
- La cache del plugin è sanificata tramite estrazione con whitelist.
- Tieni `allowInsecureTls` disattivato a meno che il log lo richieda e la rete sia fidata.
- Contributor: `npm run test:contract` esegue i test di contratto Matter e `npm run test:coverage` la suite con le soglie di copertura; vedi il README, sezione Sviluppo.
