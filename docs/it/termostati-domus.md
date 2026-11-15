# Termostati Domus e KSA

## Problema

In alcuni impianti i seguenti elementi non sono allineati numericamente:

- gli ID di uscita dei termostati (`thermostat_20`, `thermostat_21`, ...),
- gli ID dei sensori DOMUS (`sensor_3`, `sensor_4`, ...),
- l'ID di configurazione del termostato (`CFG_THERMOSTATS.ID`, il "programma" su cui scrive la centrale).

Qualunque assunzione implicita (`output == sensor == cfg`) fa sì che un comando cambi la stanza sbagliata.

## Namespace

Il plugin tratta questi elementi come tre namespace distinti:

| Namespace | Usato per | Esempio |
|---|---|---|
| Uscita | Identità HomeKit e Matter (`thermostat_<outputId>`) | `thermostat_21` |
| Configurazione del termostato | L'ID che la centrale accetta in `WRITE_CFG` (`CFG_THERMOSTATS.ID`) | `3` |
| Sensore DOMUS | Telemetria della stanza. `STATUS_TEMPERATURES.ID` è **questo** ID, non l'ID di configurazione | `4` |

## Instradamento dei Comandi (fail-closed)

Per scrivere su un termostato il plugin ha bisogno del suo ID di configurazione. Prende il primo di questi che esiste e **non ripiega mai su un'ipotesi una volta che una fonte esplicita fallisce**:

1. `domusThermostat.manualCommandPairs` (la tua coppia esplicita, o una scritta dall'import KSA).
2. Il programma `PRG_THERMOSTATS` della centrale stessa (live, oppure dalla cache KSA).
3. Un'ipotesi verificata, solo sulle centrali senza programmi termostato e senza una coppia: l'ID del sensore DOMUS, poi l'ID dell'uscita, accettati solo se la configurazione letta per quell'ID è coerente con quanto il termostato riporta in realtime.

Una scrittura viene **rifiutata con un errore, e non viene inviato nulla**, quando:

- l'ID di una coppia o di un programma non può essere letto dalla centrale (`cfg id X (from ... ) could not be read from the panel; write refused`);
- l'uscita non è l'uscita di riscaldamento o di raffrescamento di alcun programma su una centrale che ha dei programmi;
- un'ipotesi non corrisponde a quanto il termostato riporta in realtime, o è ambigua (due termostati esattamente nello stesso stato non si possono distinguere).

L'errore per un'ipotesi indica la riga esatta di `manualCommandPairs` da aggiungere.

## Forme di Scrittura

Il plugin invia solo ciò che il comando modifica, nella stessa forma dell'app web ufficiale Ksenia, incapsulato in `WRITE_CFG` / `CFG_ALL`:

| Comando | Payload per il termostato (`ID` = ID di configurazione) |
|---|---|
| Modalità Off | `{ ID, ACT_MODE: "OFF" }` |
| Modalità Heat | `{ ID, ACT_MODE: "MAN", ACT_SEA: "WIN" }` |
| Modalità Cool | `{ ID, ACT_MODE: "MAN", ACT_SEA: "SUM" }` |
| Modalità Auto | `{ ID, ACT_MODE: "AUTO" }` |
| Setpoint | `{ ID, WIN` oppure `SUM: <intero blocco della stagione, riletto subito prima, con il solo TM modificato> }` |
| Modalità e setpoint insieme | Un'unica scrittura con entrambe le parti, nell'ordine giusto |

- Un **setpoint** rilegge la configurazione di quel termostato subito prima di scrivere e invia il blocco della stagione attiva con la sola temperatura target (`TM`) modificata. Non invia mai una modalità: con il termostato Off resta Off, in Auto il programma resta attivo.
- La **stagione** deriva dal valore realtime `ACT_SEA`, altrimenti dalla lettura della configurazione; vince l'osservazione più recente e una scrittura confermata vale solo finché la centrale non mostra altro. Un "cool" che la centrale non ha mai confermato non sposta i setpoint successivi sulla stagione estiva.
- I comandi per lo stesso termostato vengono uniti (l'ultima modalità e l'ultimo setpoint partono insieme), e due accessori che condividono un unico termostato della centrale non si sovrascrivono a vicenda.
- La scadenza è `commandTimeoutMs`; una scrittura ancora in coda dopo di essa viene rifiutata.
- Il plugin si accorge delle modifiche di configurazione fatte sulla centrale (notifiche `NM_CHANGES`, contatore `PRG_CHECK`) e rilegge la configurazione di un termostato prima di usarla di nuovo. Resta ancora da confermare su una centrale reale se la centrale invia queste notifiche per le modifiche fatte dalla tastiera; la rilettura prima di ogni setpoint protegge comunque la scrittura.
- Una riconnessione non riapplica la configurazione della sessione precedente sopra lo stato live.

## Autorità dello Stato Realtime

`STATUS_TEMPERATURES` governa, per ogni termostato:

- la modalità (`off`, `heat`, `cool`, `auto`),
- la temperatura target (in Auto il target mostrato è sempre quello del programma),
- l'attività corrente (HomeKit "Current Heating/Cooling State": in Auto segue la stagione),
- la stagione attiva.

Una modalità realtime sconosciuta (qualunque valore diverso da OFF, MAN, AUTO) viene mostrata come riscaldamento o raffrescamento in base al setpoint attivo, con un solo warning che ti chiede di segnalare il valore.

La **temperatura corrente** proviene dal sensore DOMUS della stanza. La temperatura interna della scheda della centrale viene usata solo per i termostati che non hanno alcuna fonte di temperatura, e solo quando cambia. `domusThermostat.sensorFreshnessMs` indica per quanto tempo una lettura realtime del termostato ha la precedenza sulla lettura del sensore DOMUS.

### Associazione per nome tra termostati e sensori DOMUS

Quando nessuna coppia o programma collega un termostato a un sensore, il plugin li associa per nome. Un sensore è condiviso solo tra corrispondenze di nome **complete** (come le uscite di riscaldamento e raffrescamento della stessa stanza): a un termostato non viene mai assegnato il sensore di un'altra stanza con un nome simile.

## Uscite di Riscaldamento e Raffrescamento

Un programma Ksenia può avere un'uscita di riscaldamento e una di raffrescamento (i dati del programma lo dicono: `HEATING_OUT`, `COOLING_OUT`). Il loro ruolo deriva dal programma oppure, senza dati del programma, dal nome dell'uscita sulla centrale stessa, mai da un nome personalizzato o Matter.

- Su **Matter** compaiono come due termostati, solo riscaldamento e solo raffrescamento. L'uscita di riscaldamento mostra Off mentre il programma gira in estate (quella di raffrescamento mentre gira in inverno), rifiuta un setpoint o Heat in quella stagione e non inoltra Off (che fermerebbe l'altra uscita).
- Su **HomeKit** in questa versione non cambia nulla: ogni uscita è un termostato con una propria modalità.

Senza dati del programma (né `PRG_THERMOSTATS` né cache `.ksa`) il lato Matter decide tra solo riscaldamento e raffrescamento in base al nome al primo login; con la cache `.ksa` o dal secondo login in poi, il ruolo è noto quando l'endpoint viene registrato.

## Import KSA

`ksaImport` analizza il backup `.ksa` e costruisce:

- `manualCommandPairs` per l'instradamento dei comandi,
- `manualPairs` per la telemetria delle stanze,
- mappatura delle stanze e nomi personalizzati, opzionali.

L'import **non sostituisce mai le tue coppie**: le coppie che hai configurato vincono, il backup aggiunge solo i termostati che non hai mappato, e un backup vuoto non svuota mai le tue liste. Quando la tua coppia differisce dal backup, una riga di log indica il termostato e i due valori.

Il plugin salva solo dati sanificati (`klares4-ksa-cache.json`); nessun payload `.ksa` grezzo viene conservato.

## Flusso Operativo Tipico

1. Imposta `ksaImport.enabled=true` e `filePath`.
2. Riavvia Homebridge.
3. Controlla i log di anteprima con le mappature dei termostati derivate.
4. Imposta `ksaImport.applyAtStartup=true` per rendere persistenti in `config.json` i blocchi selezionati.
5. Riavvia e verifica i comandi dei termostati con l'app Ksenia: cambia la stanza giusta, e i programmi settimanali e le temperature comfort non vengono toccati.
