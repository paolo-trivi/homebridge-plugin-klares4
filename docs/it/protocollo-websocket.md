# Protocollo WebSocket

## Trasporto e Sessione

- Destinazione della connessione:
  - HTTPS WSS: `wss://<ip>:443/KseniaWsock/`
  - HTTP WS: `ws://<ip>:80/KseniaWsock/`
  - Un indirizzo IPv6 va tra parentesi quadre nell'URL.
- Sottoprotocollo WebSocket: `KS_WSOCK`.
- TLS: la centrale usa un certificato autofirmato e impostazioni TLS vecchie. Con `allowInsecureTls: true` (e `https`) il plugin salta la verifica del certificato e ammette i flag di rinegoziazione legacy; senza, la connessione è rigorosa. Entrambi i fallimenti vengono riconosciuti nel log con un suggerimento che nomina `allowInsecureTls`.
- I frame più grandi di 4 MiB (i frame reali sono di qualche decina di kB) chiudono la connessione, che viene poi ristabilita.
- Heartbeat: un ping WebSocket nativo ogni `heartbeatInterval`. Nessun pong per due intervalli indica una connessione semiaperta: il plugin segnala subito "disconnected", i comandi in sospeso falliscono immediatamente e la sessione si riconnette.

## Envelope e CRC

Ogni frame, in entrambe le direzioni, è un oggetto JSON:

| Campo | Significato |
|---|---|
| `SENDER`, `RECEIVER` | Etichetta del mittente (l'opzione `sender`); la centrale risponde con un proprio identificativo |
| `CMD` | Famiglia di comando: `LOGIN`, `READ`, `REALTIME`, `CMD_USR`, `WRITE_CFG` e le relative risposte `*_RES`, `NOT_MASK_UNSOLICITED` |
| `ID` | Identificativo della richiesta, riportato dalla risposta (alcuni firmware lo restituiscono come numero JSON) |
| `PAYLOAD_TYPE` | Su cosa verte il comando (`ZONES`, `MULTI_TYPES`, `CFG_THERMOSTATS`, `CMD_SET_OUTPUT`, ...) |
| `PAYLOAD` | Un oggetto. `ID_LOGIN` (la sessione) e `PIN` vengono compilati dal plugin |
| `TIMESTAMP` | Secondi Unix, come testo |
| `CRC_16` | CRC-16 del frame (polinomio 0x1021, seed 0xFFFF, come in `websocket-client/crc16.ts`) calcolato sui byte UTF-8 fino alla chiave `"CRC_16"` inclusa, scritto come `0x` seguito da quattro cifre esadecimali. L'algoritmo del plugin ha corrisposto a ogni frame in ingresso delle catture reali su cui è stato verificato |

**I frame in ingresso vengono controllati prima che qualunque componente li legga.** Un frame viene scartato e registrato nel log (mai citato, perché può contenere nomi dell'impianto) quando non è JSON valido, non è un oggetto, non ha `CMD`, ha un `PAYLOAD` che non è un oggetto, oppure è solo ASCII e porta un `CRC_16` che non corrisponde (corruzione certa). Un frame con testo non ASCII (un nome accentato, per esempio) il cui `CRC_16` differisce viene accettato e segnalato una volta, con la richiesta di aprire una issue: come la centrale codifichi quei caratteri per il CRC non è ancora stato verificato su una centrale reale. Un frame senza `CRC_16` viene accettato. Il log conta i frame scartati nella sessione.

`RESULT` nelle risposte viene letto ovunque allo stesso modo (maiuscole e spazi ignorati, quindi `ok` è accettato); un `RESULT` che non è testo è un rifiuto.

## Login e Protezione del Login

- Comando di login: `CMD=LOGIN`, `PAYLOAD_TYPE=UNKNOWN`, con `PIN`. Su un `LOGIN_RES` accettato il plugin salva `ID_LOGIN` e avvia la sincronizzazione. Il frame `LOGIN` viene registrato solo a livello debug, mascherato, e mai a ogni riconnessione a livello normale.
- **Cosa conta come login rifiutato:** un rifiuto esplicito della centrale, con o senza l'ID della richiesta. Solo i rifiuti contano per la protezione.
- **Dopo 3 login rifiutati di fila** il plugin non si ferma per sempre: rallenta a **un tentativo all'ora**, a ogni tentativo rifiutato scrive nel log cosa controllare (il PIN, e che l'utente sia abilitato sulla centrale), e si azzera al primo login accettato. Riavviare Homebridge riconnette subito. Il rallentamento protegge dalle centrali che bloccano un utente dopo codici errati.
- **Un login senza una risposta utilizzabile** (nessuna risposta prima del timeout di login, la centrale che chiude il socket prima, una risposta accettata senza ID di sessione, un errore di rete) non dice nulla sul PIN: resta nel normale backoff di riconnessione, al massimo 60 secondi tra un tentativo e l'altro. Dopo 5 di fila un warning indica le cause probabili (la centrale si sta riavviando, è occupata o ha raggiunto il limite di sessioni aperte).

## Sincronizzazione

Ogni login corrisponde a una sincronizzazione. Il plugin invia, in ordine:

1. `READ/ZONES`
2. `READ/MULTI_TYPES` (`OUTPUTS`, `BUS_HAS`, `SCENARIOS`)
3. `READ/STATUS_OUTPUTS`
4. `READ/STATUS_BUS_HA_SENSORS`
5. `READ/STATUS_SYSTEM`
6. `READ/PRG_THERMOSTATS`
7. `READ/CFG_THERMOSTATS`
8. `REALTIME/REGISTER` per `STATUS_ZONES`, `STATUS_OUTPUTS`, `STATUS_BUS_HA_SENSORS`, `STATUS_SYSTEM`, `STATUS_TEMPERATURES` e `SCENARIOS`

La sincronizzazione è **completa solo quando la centrale ha accettato la registrazione realtime**.

- Una lettura `ZONES` o `MULTI_TYPES` rifiutata, o una registrazione realtime rifiutata, fa fallire la sincronizzazione: il rifiuto viene registrato come warning, la sessione viene chiusa e il plugin si riconnette con backoff.
- Se la centrale rifiuta la stessa lettura di discovery (`ZONES` o `MULTI_TYPES`) in 3 sincronizzazioni di fila, la sincronizzazione si completa senza di essa (degradata): gli altri dispositivi funzionano, i dispositivi della lettura rifiutata non vengono né scoperti né rimossi, e un warning indica la lettura. Una registrazione realtime rifiutata porta sempre alla riconnessione: senza di essa non arriverebbe mai alcun cambio di stato.
- Una lettura di stato o dei termostati rifiutata viene registrata e la sincronizzazione prosegue: la registrazione realtime riporta di nuovo lo stato iniziale. La risposta `CMD_NOT_AVAILABLE` a `PRG_THERMOSTATS`, che le centrali danno a ogni login, è prevista e non viene segnalata.
- Una centrale che non risponde mai alla registrazione realtime viene riconnessa dopo 60 secondi.
- Un dispositivo che una sezione di discovery completa non elenca più viene rimosso dallo stato live del client (così un dispositivo eliminato o ricategorizzato non può continuare a ricevere lo stato del suo successore). Una lettura in cui un elemento non ha potuto essere elaborato non rimuove nulla. La piattaforma rimuove gli accessori solo dopo tre sincronizzazioni complete.
- Gli stati ricevuti per dispositivi mai scoperti vengono conservati per al massimo 512 ID.

## Riconnessione

Backoff esponenziale a partire da `reconnectInterval`, con un tetto di 60 secondi e circa il 10 % di jitter, un solo timer alla volta. Il backoff riparte solo dopo una **sincronizzazione completa**, non dopo un semplice login: una centrale che accetta il login ma rifiuta le letture dei dati viene riprovata con un ritardo crescente. Dopo che la protezione del login ha rallentato la riconnessione, il ritardo è di un'ora.

## Routing

- Le risposte (`*_RES`) passano dal router del protocollo; i payload `READ_RES` aggiornano lo stato di discovery e le cache.
- `REALTIME_RES/REGISTER_ACK` e le variazioni realtime aggiornano entrambi lo stato runtime.
- `NOT_MASK_UNSOLICITED` con `NM_CHANGES` segnala al plugin che la configurazione di un termostato è cambiata sulla centrale; la configurazione in cache viene scartata e riletta prima di essere usata di nuovo.
- Una voce malformata in un frame, o un errore nella gestione di un dispositivo, viene registrata con il tipo di frame, l'ID del dispositivo e uno stack trace e non scarta gli altri dispositivi del frame.

## Comandi

| Comando | Usato per |
|---|---|
| `CMD_USR` / `CMD_SET_OUTPUT` | Luci, dimmer, tapparelle, cancelli |
| `CMD_USR` / `CMD_EXE_SCENARIO` | Scenari |
| `WRITE_CFG` / `CFG_ALL` con `CFG_THERMOSTATS` | Termostati (risposta `WRITE_CFG_RES`) |

Il fallback legacy per i termostati `WRITE/THERMOSTAT` non viene usato. I comandi raggiungono solo uscite e scenari che il plugin ha scoperto di quel tipo: un comando per qualunque altra cosa (un accessorio in cache ormai obsoleto di un'uscita nascosta, un topic MQTT) viene rifiutato e non viene inviato nulla. Anche prima che la prima sincronizzazione abbia elencato i dispositivi, i comandi provenienti da accessori in cache vengono rifiutati.

### Ciclo di vita di un comando

`requested` → `queued` → `sent` → `acknowledged` (la risposta porta `RESULT=OK`) oppure `state-confirmed` (l'uscita è davvero cambiata) → oppure `rejected` / `timed out`. Una semplice scrittura sul socket non è mai un successo.

- **Coda.** I comandi vengono accodati per dispositivo. La scadenza è `commandTimeoutMs`: un comando ancora in coda dopo di essa viene rifiutato, mai inviato in ritardo. Al massimo 4 comandi attendono dietro a quello in esecuzione per un dispositivo.
- **Politiche per dispositivo.** Luci, dimmer e tapparelle: `latest-wins` (si conserva solo il comando in attesa più recente, gli altri vengono rifiutati). Cancelli e scenari: `reject-while-busy` (premere di nuovo mentre un impulso attende la centrale viene rifiutato). Scritture dei termostati: seriali, una in esecuzione e una in attesa per ogni termostato della centrale (i comandi per lo stesso termostato vengono uniti prima dell'accodamento).
- **Correlazione.** La risposta viene associata tramite `ID`; vengono associati anche gli ID numerici. Solo quando la centrale non fornisce un ID utilizzabile ed esiste esattamente un comando in sospeso compatibile viene usato quello (`single-compatible`). Un ID di risposta già regolato non viene riutilizzato.
- **Conferma di ricezione.** Per ogni comando che modifica qualcosa sulla centrale (`CMD_USR`, `WRITE_CFG`) solo un `RESULT=OK` esplicito lo conferma; una risposta senza di esso è un fallimento, e un comando inviato senza alcuna conferma è un errore, mai un successo.
- **Conferma dello stato.** Le scritture sulle uscite (luci, dimmer, tapparelle) sono confermate dallo stato realtime solo come **transizione osservata dopo la registrazione del comando**: l'uscita deve effettivamente passare allo stato richiesto. Uno stato che l'uscita aveva già, o l'evento in ritardo di un comando precedente sulla stessa uscita (per al massimo un timeout di comando), non conta; i numeri vengono confrontati in modo rigoroso; un rifiuto da parte della centrale prevale sempre.
- **Validazione.** `NaN`, `Infinity`, una luminosità o una posizione che non sono numeri e un on/off che non è booleano vengono rifiutati prima che venga inviato qualunque cosa.
- Quando la connessione cade, ogni comando in sospeso e in coda viene rifiutato.

## Payload Rilevanti per i Termostati

### `CFG_THERMOSTATS`

Configurazione persistente dei termostati. Viene letta al login, riletta prima di una scrittura del setpoint e usata per le forme di scrittura parziale descritte in [Termostati Domus e KSA](./termostati-domus.md). Il suo contatore `PRG_CHECK` è la base per il rilevamento delle modifiche.

### `STATUS_TEMPERATURES`

Stato realtime del termostato: temperatura corrente, target (quando è un numero valido), modalità HVAC, stagione (`ACT_SEA`) e stato dell'uscita. **Il suo `ID` è l'ID del sensore DOMUS**, non l'ID di configurazione del termostato.

### `STATUS_OUTPUTS`

Stato runtime delle uscite; per i termostati è secondario (correlazione dell'attività), non un'autorità per il routing. Per luci e tapparelle è la fonte realtime della conferma dello stato.

### `PRG_THERMOSTATS`

Mappa strutturale, se il firmware la espone: ID del programma del termostato, sensore DOMUS collegato (`PERIPH.PID`) e uscite di riscaldamento e raffrescamento (il loro ruolo). Usata per risolvere il routing dei comandi senza tirare a indovinare.

### Campi delle zone

`BYP` diverso da `NO` significa esclusa; `T` diverso da `N` significa manomissione (`StatusTampered` di HomeKit); `STA` è aperta/chiusa; un campo assente da un aggiornamento lascia invariato quel campo della zona. Un valore che il plugin non ha mai visto prima viene registrato nel log una sola volta.

### Valori dei sensori

Un valore che la centrale segnala come mancante o illeggibile (`NA`, vuoto, non numerico), o fuori dall'intervallo plausibile (999 °C, 150 % di umidità, una posizione di tapparella pari a `abc`), viene scartato: il dispositivo resta "non ancora osservato" (HomeKit "No Response") finché non arriva una lettura valida.
