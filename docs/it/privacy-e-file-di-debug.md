# Privacy e file di debug

## Cosa invia il plugin, e dove

- **Nessuna telemetria.** Il plugin non invia nulla a terzi. La segnalazione anonima degli errori (Sentry) esisteva fino alla 2.2.x ed è stata rimossa nella 2.3.0 insieme alla sua dipendenza, e un test fallisce se mai tornasse una dipendenza di telemetria o analytics.
- Le uniche connessioni di rete che il plugin apre sono il WebSocket verso **la tua centrale** e, se abiliti il bridge MQTT, la connessione verso **il tuo broker**.
- Una chiave `telemetry` rimasta in `config.json` viene ignorata; il plugin scrive una riga di log che lo dice.

## Cosa viene memorizzato e quanto è privato

- **Il PIN è memorizzato in chiaro in `config.json`**, che è il file di Homebridge stesso. Usa un utente dedicato sulla centrale con i soli diritti che servono a questo plugin e proteggi la cartella di storage di Homebridge.
- Il PIN non viene mai scritto nel log, su MQTT o nel file di debug. Nel log il valore di ogni chiave simile a una credenziale (`PIN`, `PIN_CODE`, `USER_PIN`, `PASSWORD`, `CODE`, `TOKEN`, ...) è mascherato, qualunque sia il tipo e ovunque si trovi (un PIN tra virgolette, un numero, un frame troncato, un testo JSON trasportato come stringa). Il frame `LOGIN` viene registrato solo a livello debug, mascherato. Il broker MQTT viene registrato solo come `scheme://host:port`.
- I file che il plugin crea per la prima volta (file di debug, cache KSA, store Matter, elenco dispositivi, esempio di mappatura delle stanze) sono privati (`0600`); i file esistenti mantengono i propri permessi. I file temporanei rimasti da un crash (per `config.json` contenevano il PIN) vengono rimossi all'avvio quando hanno più di cinque minuti.
- La cache KSA contiene solo dati sanificati; il backup `.ksa` grezzo non viene memorizzato.

## Il file di debug

`generateDebugFile: true` registra il traffico WebSocket grezzo al prossimo avvio, per `debugCaptureDurationMs` (default 60 secondi, da 10 s a 30 min), e scrive `klares4-debug-<timestamp>.json` nella cartella di storage di Homebridge. Il flag si disattiva da solo in `config.json` (se il file non può essere riscritto il plugin lo dice e riprova al prossimo avvio). Se Homebridge si ferma prima della fine della cattura, il file viene scritto allo spegnimento con quanto registrato.

**Il file di debug è riservato.** Contiene i nomi dei tuoi dispositivi e lo stato del tuo impianto di allarme. PIN, dati dell'account, numeri di serie della centrale e posizione della casa sono mascherati. Non allegarlo a una issue pubblica; invialo in privato, e solo a una persona di cui ti fidi. Eliminalo quando non ti serve più.

### Cosa viene mascherato

Mascherato per chiave, a qualsiasi profondità, nei frame in entrambe le direzioni, negli snapshot dei dispositivi e nelle sezioni derivate da essi, qualunque sia il tipo di valore (un frame che non può essere analizzato viene mascherato come testo); il valore mascherato è scritto `***MASKED***`:

- credenziali, per famiglia e in qualunque grafia (`PIN`, `USER_PIN`, `userPin`, `PINCODE`, `PIN1`): `pin`, `pwd`, `passwd`, `password`, `passcode`, `pass`, `secret`, `token`, e `code` quando è da solo o segue una parola come `pin`, `user`, `access` o `security` (`ERROR_CODE` e `RESULT_CODE` restano leggibili). Una chiave che contiene soltanto quelle lettere (`PING`, `PASSIVE`) non viene mascherata. Il log usa la stessa regola;
- identificativi, per famiglia: `serial`, `sn`, `mac`, `imei`, `iccid`, `email` (`SERIAL_NUMBER`, `macAddress`, ...);
- posizione: `LAT`, `LONG`, `LON`, `LNG`, `LATITUDE`, `LONGITUDE`, `POSITION` nei frame, e gli orari di alba e tramonto (`DAWN`, `DUSK`), che insieme alla data rivelano latitudine e longitudine. L'apertura di una tapparella negli snapshot dei dispositivi (`status.position`, un semplice numero) viene conservata;
- identità: la descrizione e l'ID dell'account (`DESCRIPTION`, `ID_ACCOUNT`) e l'identificativo della centrale che i frame provenienti dalla centrale portano in `SENDER`.

**Non mascherato, di proposito:** i nomi di zone, uscite, scenari e dispositivi bus, i campi di stato, `ID_LOGIN`, `CRC_16`, `TIMESTAMP` e le stringhe del firmware: servono per diagnosticare un problema.

### Limiti

La cattura tiene in memoria al massimo 5.000 frame e 2 MiB di traffico (una cattura reale di 15 minuti pesa circa 0,3 MB). I frame successivi vengono contati (`captureInfo.droppedMessages` nel file), viene registrato un avviso (`[DEBUG] Capture buffer full ...`) e la cattura termina comunque in tempo.

Ogni frame viene scritto una sola volta, come testo JSON in `rawMessages[].rawData` (le versioni precedenti scrivevano anche una copia `parsed`: analizza `rawData`). Un frame mascherato non corrisponde più al proprio `CRC_16`. Uno snapshot dei dispositivi preso durante la cattura viene salvato solo se i dispositivi sono cambiati rispetto al precedente; il primo e l'ultimo vengono sempre salvati, al massimo 60 in mezzo.

### Righe di log

- All'inizio: `[PRIVACY] The file will be confidential: it lists your devices and the state of your alarm system.`
- Quando il file viene scritto: quattro righe `[PRIVACY]` (riservato; cosa viene mascherato; non allegarlo a una issue pubblica; modalità `0600`) e il percorso del file.

### File scritti da versioni precedenti

I file di debug scritti dalla 2.2.x e precedenti sono `0644` e contengono la posizione della casa e la descrizione dell'account. Eliminali, oppure limitane i permessi (`chmod 600`), prima di condividerli o copiarli altrove. Se ne hai condiviso uno, hai condiviso le coordinate dell'impianto.

## Segnalare un problema di sicurezza

Vedi [`SECURITY.md`](../../SECURITY.md): usa la segnalazione privata delle vulnerabilità di GitHub o l'indirizzo email indicato lì, mai una issue pubblica.
