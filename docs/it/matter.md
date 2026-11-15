# Matter

Con **Homebridge 2.x** ogni accessorio del plugin è esposto anche via Matter, accanto a HomeKit e MQTT. Questa pagina descrive come si comporta il lato Matter e come risolvere i problemi.

## Versioni

- Homebridge **2.5.x** (matter.js 0.18) è la versione verificata: i test di contratto girano sul vero stack Matter di Homebridge, con ogni tipo di accessorio, termostato nativo compreso.
- Homebridge **2.4.x** è coperto da un job CI di contratto. Qui le chiamate di register e unregister ritornano prima che l'endpoint esista; il plugin lo osserva da sé e mantiene un'attesa lunga dove la registrazione si completa più tardi.
- Homebridge 1.x non ha il supporto Matter e non è testato.
- Il commissioning Matter, l'abbinamento e il child bridge Matter appartengono a Homebridge. **Non eliminare né rigenerare mai il child bridge** per risolvere un problema: le fabric già commissionate andrebbero perse e ogni controller dovrebbe abbinarsi di nuovo.

## Cosa viene esposto

Tutti i dispositivi che il plugin espone (vedi il README, [Politica di esposizione](../../README.md#politica-di-esposizione-fail-closed)), meno ciò che disattivi: `matterExposure` per tipo, `matterOverrides` per dispositivo e le liste `exclude*`. Le impostazioni solo Matter non cambiano mai HomeKit o MQTT. Precedenza: liste di esclusione, poi `exposed` del singolo dispositivo, poi il tipo in `matterExposure`, poi il default (esposto).

## Termostati

- **Thermostat nativo.** Un termostato si registra come un vero Thermostat Matter che dichiara solo gli attributi di ciò che sa fare. Homebridge 2.5 ne ricava le feature: un'uscita solo riscaldamento ha il riscaldamento e non ha raffrescamento, né Auto, né Occupancy; una solo raffrescamento il contrario; un'uscita che fa entrambi mantiene riscaldamento, raffrescamento e Auto. Il ruolo deriva dai dati del programma termostato della centrale (o dal nome dell'uscita della centrale stessa), mai da un nome che imposti in `matterOverrides` o `customNames`.
- **Stato di funzionamento.** Il termostato pubblica se la sua uscita di riscaldamento o raffrescamento è in funzione.
- **Un programma, due uscite.** Un'uscita di riscaldamento e una di raffrescamento dello stesso programma compaiono come due termostati. Ciascuno mostra Off fuori dalla propria stagione e rifiuta lì un setpoint o una modalità; l'uscita di riscaldamento non inoltra Off mentre il programma gira in estate (fermerebbe il raffrescamento).
- **Un comando rifiutato viene segnalato.** Auto o Cool su un termostato solo riscaldamento viene rifiutato al controller invece di essere accettato e ignorato. Un comando che non può raggiungere la centrale fallisce in modo visibile e torna il valore precedente.
- **Comandi rapidi.** Un comando inviato poco dopo un altro non viene scartato come "già corrente" perché la centrale non aveva ancora riportato il primo; due passi rapidi di +1 °C si sommano a +2 °C.
- **Temperatura sconosciuta.** Un termostato di cui non è stata letta la temperatura ambiente la mostra come sconosciuta, non come un 20 °C inventato.
- **Intervalli.** Fissi: riscaldamento 5-30 °C, raffrescamento 16-35 °C. `temperatureDefaults` non si applica a Matter.

### Fallback e recupero automatico

Se una versione di Homebridge rifiuta l'endpoint Thermostat nativo, il plugin riprova una volta con il payload delle versioni precedenti (log: `trying the payload of earlier versions before falling back to TemperatureSensor`). Se viene rifiutato anche quello, il termostato si registra come **sensore di temperatura** in sola lettura e la scelta viene salvata in `klares4-matter-fallback.json`.

- Un termostato che una versione precedente aveva salvato come fallback a sensore di temperatura ottiene **un tentativo automatico** al primo avvio della 2.3.0, senza alcuna impostazione (log: `was saved as a TemperatureSensor fallback by an earlier version; trying the native Thermostat once`). Se Homebridge non lo accetta, torna il sensore e non viene fatto nessun altro tentativo automatico.
- `matterRecoveryRequests` consente un ulteriore tentativo esplicito per un dispositivo: `[{ "deviceId": "thermostat_18", "generation": 1 }]`. La generation viene consumata una sola volta e salvata prima della modifica; aumenta il numero solo per un nuovo tentativo deliberato; non aumentarlo a ogni avvio. In caso di errore o di recupero interrotto il plugin torna al sensore di temperatura. Non eliminare mai lo store di fallback.
- Un file che il plugin non capisce (una versione più recente, un layout sconosciuto) viene lasciato intatto e lo stato resta in memoria. Un file illeggibile viene copiato in `klares4-matter-fallback.json.unreadable.bak` prima che parta un nuovo store. Lo store acquisisce un campo opzionale `nativeShapeRevision` che la 2.2.0 legge senza problemi.
- Se Homebridge 2.4.x richiede il secondo payload, a ogni riavvio si prova di nuovo prima il payload conforme (la scelta è per processo).

### Identità

Una sostituzione mantiene l'`uniqueId` dell'endpoint solo quando il nuovo endpoint è lo stesso dispositivo con la stessa funzione: una ridenominazione, un altro payload dello stesso tipo di dispositivo, una luce che diventa dimmer. **Il passaggio termostato ↔ sensore di temperatura cambia la funzione e quindi l'identità, di proposito**: un controller che mantenesse l'identità potrebbe conservare scene che impostano una temperatura su un sensore in sola lettura. Apple Home, Alexa e Google mostrano allora un accessorio nuovo: stanze e automazioni che usavano il sensore vanno impostate di nuovo. Succede una volta per i termostati che nella 2.2.0 erano sensori.

## Nomi e ridenominazioni

- I nomi arrivano dalla centrale (o da `customNames`, `matterOverrides`), vengono puliti (trim, caratteri che HomeKit rifiuta sostituiti) e risolti in un unico lotto, così lo stesso insieme di dispositivi converge sempre agli stessi nomi. Il dispositivo controllabile si tiene il nome pulito; un sensore passivo con la stessa etichetta riceve il suffisso ` - Sens.`.
- Il limite Matter sui nomi (32) è contato in unità di codice UTF-16, come Homebridge e matter.js, quindi un carattere non viene mai tagliato a metà e due accessori non possono finire con lo stesso nome troncato. I nomi HomeKit contano i caratteri (64).
- `klares4-matter-names.json` mantiene stabili i nomi tra i riavvii. I nomi dei dispositivi ancora presenti sulla centrale non scadono mai; il nome di un dispositivo scomparso resta riservato per 30 giorni da quando è stato visto l'ultima volta. Il file viene scritto in modo atomico e uno scritto da una versione più recente resta intatto dopo un downgrade.
- **Ridenominazione sul posto.** Un cambio di nome (etichetta della centrale, `matterOverrides`, una collisione risolta alla fine della prima sincronizzazione) viene scritto sull'accessorio attivo (`nodeLabel`), che mantiene la propria identità: i controller conservano stanze, preferiti e automazioni. Solo se il nuovo nome non compare il plugin ripiega su rimozione e aggiunta, e anche quel percorso mantiene l'identità. La prima ridenominazione di un accessorio appena creato può far loggare una volta, da Homebridge, `Cannot update Matter accessory ... not found in cache`: innocuo, il nome persiste. `productLabel` non viene riscritto sul posto; Homebridge lo imposta al prossimo avvio.
- Una luce che risulta essere un dimmer viene sostituita una volta da un accessorio dimmerabile (Matter non può cambiare il tipo di dispositivo sul posto) e mantiene la propria identità; resta assente per circa un secondo.
- L'analisi vocale alla fine di ogni sincronizzazione è solo diagnostica e non rinomina mai nulla.

## Rimozione (prune)

Un dispositivo eliminato o rinumerato sulla centrale viene rimosso da Matter dopo **tre sincronizzazioni complete**, anche attraverso i riavvii, senza riavviare Homebridge (anche una riconnessione è una sincronizzazione). Le regole, condivise con HomeKit:

- un accessorio conta come mancante solo se il suo tipo di dispositivo (zone, uscite, scenari, sensori) ha risposto in quella sincronizzazione; una lettura fallita alla riconnessione non fa avanzare nessuno;
- servono tre mancanze consecutive (contatori in `klares4-matter-prune.json`, ripulito degli accessori che non esistono più);
- una sincronizzazione che vede meno della metà degli accessori noti non conta nessuno come mancante (log: `Prune: discovery returned X of Y exposed endpoint(s), below the 50% safety floor`);
- le sonde di temperatura della centrale non vengono mai rimosse;
- l'ultimo dispositivo di una famiglia (l'unico scenario, per esempio) non viene rimosso automaticamente, perché una lista vuota non si distingue da una lettura fallita: rimuovilo con la lista `exclude*` corrispondente, che agisce alla prima sincronizzazione;
- gli endpoint ripristinati dalla cache di Homebridge e non registrati in questa sessione vengono giudicati nello stesso passaggio.

La riga di log `[Matter] Missing candidate: ...` indica un dispositivo assente da un certo numero di sincronizzazioni; verifica che esista ancora sulla centrale. Il riepilogo del ciclo Matter riporta `missingCandidates` e `keptFamilyNotAnswered`.

## Raggiungibilità

Quando la connessione alla centrale è interrotta, ogni accessorio Matter del plugin viene segnato "non risponde" dopo **15 secondi**, compresi quelli che Homebridge ha ripristinato dalla cache: un riavvio di Homebridge durante un'interruzione della centrale non mostra più come attuali gli ultimi stati in cache. Tornano quando torna la centrale (log: `[Matter] panel reachable again`).

## Tapparelle, dimmer, cancelli e scenari

- Una tapparella comandata da Matter mantiene la posizione che la centrale riporta come `current`, mostra il `target` richiesto e riporta apertura o chiusura finché la centrale non la mostra al target. Le automazioni su "tapparella chiusa/aperta" non scattano al comando.
- Un comando di luminosità su un dimmer spento non arriva alla centrale.
- Cancelli e scenari sono interruttori momentanei.
- Un comando Matter che arriva mentre la connessione alla centrale non è disponibile fallisce in modo visibile nel controller.

### Limiti noti (Homebridge, non risolvibili con l'API pubblica)

- LevelControl `moveWithOnOff`, `stepWithOnOff` e `stopWithOnOff` eseguono l'implementazione predefinita di matter.js senza chiamare un handler del plugin: un controller che li usa cambia lo stato Matter mentre la centrale non fa nulla, e il successivo stato della centrale riporta lo stato com'era. Non risulta che Apple Home, Alexa o Google li usino per un semplice dimmer.
- Il settle di 1 secondo dell'unregister è mantenuto (Homebridge 2.4 riporta un endpoint come assente mentre si sta ancora chiudendo).

## Tempi di registrazione

Homebridge 2.5 completa una registrazione prima di ritornare; la 2.4 la completa più tardi. Il plugin lo impara dall'osservazione: dove la registrazione si completa prima di ritornare, un accessorio che non è comparso viene ritentato dopo circa 2 secondi; altrove resta l'attesa lunga (30 s). Un endpoint conta come attivo solo quando risponde per **ogni** cluster che il plugin ha dichiarato.

## Risoluzione problemi

| Sintomo o riga di log | Significato e azione |
|---|---|
| `... was saved as a TemperatureSensor fallback by an earlier version; trying the native Thermostat once` | Il recupero automatico. Guarda le righe successive: successo, oppure il motivo per cui è tornato al fallback |
| `trying the payload of earlier versions before falling back to TemperatureSensor` | Homebridge ha rifiutato il payload conforme; segue il secondo tentativo |
| Un termostato compare come sensore di temperatura | È ricaduto nel fallback. Controlla il log per il motivo; `matterRecoveryRequests` consente un ulteriore tentativo |
| Apple Home / Alexa mostrano un nuovo termostato e il sensore è sparito | Atteso una volta dopo l'aggiornamento dalla 2.2.0 (l'identità cambia di proposito). Imposta di nuovo stanze e automazioni |
| `[Matter] Missing candidate: ...` | Un dispositivo assente dalla centrale da alcune sincronizzazioni; esce dopo tre |
| `Prune: discovery returned X of Y ... below the 50% safety floor` | Una sincronizzazione parziale: non viene rimosso nulla. Di solito innocuo; controlla la connessione alla centrale |
| `Fallback store ... is unreadable ... a copy is kept in ...unreadable.bak` | Lo store era danneggiato; il plugin ne conserva una copia e ne avvia uno nuovo |
| `register deferred: ... the Matter server is still starting` | Matter non era ancora attivo; la registrazione viene ritentata a un aggiornamento successivo |
| `Cannot update Matter accessory ... not found in cache` (Homebridge) | Una ridenominazione di un accessorio appena creato prima che Homebridge salvasse la sua cache. Innocuo |
| `HomeKit (HAP) limit reached` | Più di 149 accessori su un solo bridge: il resto resta su Matter e MQTT |
| "No handler registered for thermostat_N..." | Solo plugin precedenti alla 2.1.3; aggiorna |

## Diagnostica di rete e mDNS

La scoperta e il commissioning Matter usano mDNS (multicast DNS, porta UDP 5353). Il plugin **non** configura le interfacce di rete; quali interfacce vengono annunciate dipende da Homebridge e matter.js.

**Sintomi:** l'abbinamento fallisce o è intermittente; il bridge è visibile da un controller e non da un altro; il log di avvio avvisa `Detected another IPv4 mDNS stack running on this host`; un controller su un'altra VLAN non trova il bridge dopo un reset.

1. **Responder mDNS in conflitto.** Un altro stack mDNS nello stesso network namespace (Avahi, mDNSResponder, Bonjour, un container in host network) compete per UDP 5353. Verifica con `systemctl status avahi-daemon` o `ps aux | grep -E 'avahi|mDNSResponder|bonjour'`. Esegui Homebridge nel proprio network namespace, disattiva ciò che non ti serve, oppure limita Avahi a interfacce specifiche.
2. **Firewall.** Il multicast UDP 5353 deve essere aperto sulle interfacce interessate (`iptables -L INPUT -v -n | grep 5353`, `ufw status | grep 5353`).
3. **Stesso segmento.** Il controller e l'host di Homebridge devono trovarsi nello stesso segmento di livello 2, oppure il multicast deve essere inoltrato tra i due. Prova con `ping -c 3 224.0.0.251` e `ping6 -c 3 ff02::fb%<iface>`. Le VLAN che bloccano il multicast impediscono la scoperta.
4. **Scelta dell'interfaccia.** Controlla l'interfaccia indicata dal log di Homebridge e `ip route show default`; assicurati che il controller sia nella subnet di quell'interfaccia.

## Variabili d'ambiente (solo diagnostica)

Vengono lette quando si costruisce il registro Matter. Esistono per i test e le emergenze; non impostarle nell'uso normale. I tempi sono in millisecondi.

| Variabile | Default | Significato |
|---|---|---|
| `KLARES4_MATTER_REGISTER_TIMEOUT_MS` | 30000 | Attesa che un nuovo endpoint risponda, finché il runtime non ha mostrato che register lo aspetta |
| `KLARES4_MATTER_SETTLED_REGISTER_TIMEOUT_MS` | 2000 | La stessa, una volta che il runtime ha mostrato che register si risolve con l'endpoint già costruito |
| `KLARES4_MATTER_REGISTER_POLL_MS` | 250 | Intervallo di polling di quell'attesa |
| `KLARES4_MATTER_REGISTER_POLL_MAX_MS` | 1000 | Intervallo di polling massimo |
| `KLARES4_MATTER_REGISTER_RETRY_MS` | 5000 | Attesa prima che una registrazione rifiutata come transitoria ("still starting") possa essere ritentata (0 ammesso) |
| `KLARES4_MATTER_STATE_BOOTSTRAP_MS` | 0 | Ritardo extra prima che gli aggiornamenti di stato raggiungano un endpoint appena registrato (override di emergenza; 0 ammesso) |
| `KLARES4_MATTER_UNREACHABLE_GRACE_MS` | 15000 | Tempo prima che gli accessori vengano segnati come non risponde (0 ammesso) |
| `KLARES4_MATTER_UNREGISTER_SETTLE_MS` | 1000 | Attesa dopo che un endpoint rimosso risulta per la prima volta assente, prima di controllarlo di nuovo (0 ammesso) |
| `KLARES4_MATTER_UNREGISTER_TIMEOUT_MS` | 3000 | Attesa che un endpoint rimosso scompaia, quando `matterUnregisterTimeoutMs` non è impostato |

## Comandi diagnostici

```bash
# Homebridge log (Docker example)
docker logs <homebridge-container> --tail 200 -f | grep -i matter

# Installed plugin version
grep '"version"' /path/to/node_modules/homebridge-plugin-klares4/package.json
```
