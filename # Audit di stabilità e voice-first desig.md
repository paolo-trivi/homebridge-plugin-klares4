# Audit di stabilità e voice-first design — `homebridge-plugin-klares4`

**Perimetro:** esclusivamente `paolo-trivi/homebridge-plugin-klares4`, con il minimo contesto Homebridge/Matter/Alexa necessario a valutarlo.  
**Snapshot analizzato:** plugin `2.1.5-rc.1`, tag/commit `92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d`; ambiente di produzione e log disponibili fino al 10 settembre 2026.  
**Metodo:** lettura del codice e dei test, esecuzione locale di build e test, analisi del fixture reale da 109 entità, stato e log del container, issue/release/CI pubbliche, specifiche Matter e documentazione Alexa.  
**Legenda delle prove:** `[Codice]`, `[Test]`, `[Log]`, `[Runtime]`, `[Homebridge]`, `[Matter]`, `[Alexa]`, `[Issue]`, `[Inferenza]`.

> Le percentuali e i punteggi vocali del report sono euristiche di prioritizzazione, non telemetria interna di Alexa. Alexa non espone al plugin né il proprio indice NLU né il nome effettivamente memorizzato dal controller.

## A. Executive summary

1. Nel breve intervallo osservabile il plugin è operativamente stabile: tre connessioni/login/sync riusciti, nessun errore WebSocket, OOM o crash anomalo. `[Log][Runtime]`
2. Questa non è ancora una prova di stabilità di lungo periodo: il log conserva circa cinque ore e non esiste uno storico Loki equivalente. `[Runtime]`
3. Build e 244 test passano su Node 22; la CI recente è verde. Il pacchetto in produzione è però una release candidate, mentre `latest` npm resta `2.1.4`. `[Test]`
4. L'attuale esposizione Matter è già scesa da 109 a 53 entità: zone e sensori sono nascosti; HomeKit/HAP non viene ridotto. `[Runtime][Codice]`
5. Il naming garantisce soltanto unicità esatta case-insensitive entro 32 caratteri; non misura collisioni vocali, semantiche, fonetiche, con stanze o intenti Alexa. `[Codice][Test]`
6. Rimangono collisioni forti tra nomi di luci e stanze, tra `Cancello` e `Apri Cancello`, e tra `Spegni Tutto` e un comando globale. `[Runtime][Inferenza]`
7. Scenari e cancelli sono esposti come prese `OnOffPlugInUnit`: è un compromesso pragmatico per renderli comandabili, ma comunica ad Alexa una semantica sbagliata. `[Codice][Matter][Alexa]`
8. Il problema più serio non è vocale: luci, tapparelle, cancelli e scenari non attendono né validano l'esito Klares; “command sent/executed” significa solo scrittura sul socket. `[Codice][Issue]`
9. Tutti i sei termostati Matter correnti sono fallback read-only `TemperatureSensor`, e il marker persistente impedisce di ritentare spontaneamente il tipo Thermostat. `[Runtime][Codice]`
10. Sono presenti 42 warning Homebridge nel ciclo di riduzione della topologia; la registrazione termina, ma la notifica ai controller può non essere arrivata. `[Log][Homebridge]`
11. Non consiglio uninstall/reinstall, reset Matter o rinomina massiva: prima servono ACK reali, analizzatore vocale, esposizione selettiva e un test controllato della cache Alexa.
12. La strategia raccomandata è evolutiva: mantenere l'identità/UUID, correggere la verità operativa, aggiungere diagnostica voice-first e rinominare solo le entità ad alto rischio.

## B. Come funziona oggi la pipeline

### B.1 Inventario e stato di produzione

| Evidenza | Risultato |
|---|---|
| Versione plugin | `2.1.5-rc.1`, uguale al tag `v2.1.5-rc.1` (`92ec1ed`) |
| Runtime | Node `24.20.0`, npm `11.19`, Homebridge `2.4.0`, matter.js `0.17.9` |
| Processo/container | container in esecuzione, un restart; nessun OOM e ultimo exit code `0` |
| Connessione Klares nel log conservato | 3 connect, 3 login, 3 sync iniziali, 3 chiusure normali `1000`; 0 errori di connessione |
| Registrazioni Matter | 215 richieste e 215 esiti registrati nei tre cicli osservati; nessun errore accessorio |
| Inventario sorgente | 109 entità nel fixture reale e nella mappa nomi persistita |
| Inventario Matter attuale | 53 entità: 18 luci, 9 tapparelle, 18 scenari, 2 cancelli, 6 sensori temperatura fallback |
| Configurazione attuale | `matterExposure.zones=false`, `matterExposure.sensors=false`; le altre categorie sono esposte |
| Attività osservata | 12 comandi luce e 17 tapparella; nessun errore loggato, ma nessuna conferma ACK applicativa |
| Warning Matter | 42 `Cannot lock ... basicInformation.state synchronously` durante il cambio di topologia |
| Retention | circa cinque ore di log; Docker ruota `10 MB × 1`, senza backend log storico |

I tre restart del child bridge seguono salvataggi/configurazioni e chiusure WebSocket normali; non hanno la firma di crash incontrollati. Le righe operative sono verificabili nel [log Homebridge](/root/smarthome/homebridge/homebridge.log:4592), mentre il blocco di warning parte dalla [notifica della parts list](/root/smarthome/homebridge/homebridge.log:8820). `[Log]`

Questo consente di dire **“nessuna instabilità osservata nella finestra”**, non **“stabilità dimostrata da mesi”**. Il container complessivo arrivava a circa 1,1 GiB, ma include più processi Homebridge; un singolo snapshot non dimostra una perdita di memoria. `[Runtime]`

### B.2 Dal pannello Klares all'entità interna

1. Il WebSocket effettua login, legge zone, output, scenari, sensori e termostati, poi si registra agli aggiornamenti realtime.
2. Discovery costruisce un `KlaresDevice` con `id`, `type`, `name`, `description` e stato.
3. Un eventuale `customName` viene applicato mutando `name` e `description`; il modello non conserva in modo esplicito `sourceName` e `customName` come due fatti distinti. `[Codice]`
4. I dispositivi vengono registrati separatamente su HAP, Matter e, se abilitato, MQTT.

L'assenza di provenienza è un rischio architetturale: a valle non si può spiegare con certezza quale nome arrivasse dal pannello e quale fosse un override. È anche facile che un file diagnostico serializzi l'oggetto già mutato. Non è, da solo, la causa di un comando Alexa errato.

### B.3 Sanitizzazione e assegnazione del nome Matter

La funzione condivisa [`cleanDisplayName`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/display-name.ts#L53-L65):

- sostituisce `+` con `e`;
- rimuove parentesi e caratteri non ammessi;
- compatta gli spazi;
- elimina separatori ai bordi;
- tronca a 32 unità JavaScript per Matter e 64 per HAP.

Il limite è applicato con `slice`, quindi conta code unit UTF-16, non scalari Unicode o byte UTF-8, e può troncare a metà parola. Nel fixture italiano non spezza emoji o surrogate pair, ma `Finestra Bagno Matrimoniale - Sens.` diventa `Finestra Bagno Matrimoni - Sens.`. `[Codice][Test]`

La mappa batch [`buildMatterNameMap`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/platform/matter-name-map.ts#L34-L82) ordina per priorità e UUID, quindi prova:

1. base sanitizzata;
2. suffisso di tipo, per esempio `- Sens.`;
3. suffisso derivato dall'UUID.

Zone/sensori hanno priorità 1; dispositivi azionabili priorità 10. A parità di priorità vince l'UUID lessicograficamente, non il nome più utile alla voce. Il vincolo è solo `toLocaleLowerCase`: non ci sono NFKC, rimozione accenti, espansione abbreviazioni, singolare/plurale, similarità fonetica, stanze o intenti riservati. `[Codice]`

La persistenza in `klares4-matter-names.json` protegge la stabilità fra riavvii e riserva per 30 giorni nomi di entità momentaneamente assenti. È una buona scelta contro il name churn. Il loader però accetta record senza verificare realmente versione, duplicati, tipo, lunghezza, caratteri e timestamp; un file corrotto o vecchio può diventare autorità senza bonifica. `[Codice]`

Nel percorso incrementale di fallback, [`suffixFor`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/platform/matter-name-sanitizer.ts#L236-L243) non ricontrolla l'unicità del suffisso UUID. Inoltre il fallback rimuove i trattini ma non `_`: da `cover_27` può produrre `r_27`, nonostante il commento lo descriva come HomeKit-safe. Sono difetti algoritmici reali, ma con probabilità molto inferiore alle collisioni vocali già presenti.

### B.4 UUID, attributi Matter e cache

Per ogni device, la mappatura usa:

| Campo plugin | Destinazione osservata in Homebridge/Matter |
|---|---|
| `device.id` | UUID dell'accessorio e identità endpoint stabile |
| `displayName` finale | `BridgedDeviceBasicInformation.NodeLabel` e product label |
| `Ksenia` | vendor/manufacturer name |
| `Lares4 <type>` | product/model name |
| ID Klares | serial number |
| tipo mapper | `Descriptor.DeviceTypeList` e cluster del tipo Matter |
| `context.device` | cache interna Homebridge; non è un attributo visibile ad Alexa |

La corrispondenza è ricostruibile nel [`matter-device-mapper.ts`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/platform/matter-device-mapper.ts) e nell'implementazione [`AccessoryManager`](https://github.com/homebridge/homebridge/blob/v2.4.0/src/matter/server/AccessoryManager.ts) di Homebridge. `[Codice][Homebridge]`

La specifica richiede al bridge di esporre e aggiornare `NodeLabel`; il controller che vuole gli aggiornamenti dovrebbe monitorarlo, ma ciò non equivale a garantire che Alexa aggiorni subito friendly name, indice vocale e stanze. La regola è ancora presente in Matter Core **1.6**, §9.12.7, nella [specifica CSA corrente](https://csa-iot.org/wp-content/uploads/2026/06/23-27349-011_Matter-1.6-Core-Specification.pdf). `[Matter]`

La documentazione [`MatterAPI`](https://developers.homebridge.io/homebridge/interfaces/MatterAPI.html) suggerisce `updatePlatformAccessories` per un cambio nome. Nel sorgente Homebridge 2.4, però, il relativo handler fonde i metadati nella copia/cache preservando l'endpoint runtime e non scrive il nuovo `NodeLabel` nell'endpoint già pubblicato ([`server.ts`, update](https://github.com/homebridge/homebridge/blob/v2.4.0/src/matter/server.ts#L196-L237)). Questo spiega perché il plugin abbia adottato unregister/register; rende anche opportuno aprire un confronto upstream invece di moltiplicare workaround locali. `[Homebridge][Codice]`

Il plugin finalizza una rinomina con `unregisterPlatformAccessories` seguito da `registerPlatformAccessories` sullo stesso UUID. L'API Matter Homebridge 2.4 inoltra queste operazioni attraverso un event emitter asincrono senza attendere il listener: l'`await` del plugin attende l'emissione, non la fine materiale dell'unregister/register. Si vedano [`MatterAPIImpl`](https://github.com/homebridge/homebridge/blob/v2.4.0/src/matter/MatterAPIImpl.ts) e il [`matter-name-finalizer`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/platform/matter-name-finalizer.ts#L55-L77). `[Codice][Homebridge]`

Il probe successivo dimostra che l'endpoint torna interrogabile; non legge da Alexa il friendly name e non certifica che `NodeLabel` sia stato indicizzato. Assegnare subito `registeredDisplayName` comunica quindi uno stato **richiesto/pubblicato**, non necessariamente **osservato dal controller**.

Durante il passaggio 109 → 53 endpoint Homebridge ha esaurito i retry 42 volte con `Cannot lock ... basicInformation.state synchronously`. La famiglia del problema è documentata anche in [homebridge/homebridge#3970](https://github.com/homebridge/homebridge/issues/3970). Tutti i 53 endpoint risultano poi online, ma quei warning impediscono di assumere che ogni controller abbia ricevuto la parts-list change. `[Log][Homebridge][Inferenza]`

### B.5 Tipi Matter e cluster

| Entità Klares | Tipo Matter | Cluster/semantica principale | Valutazione |
|---|---|---|---|
| luce | `OnOffLight` / `DimmableLight` | `OnOff`, eventualmente `LevelControl` | appropriata |
| tapparella | `WindowCovering` | lift current/target | appropriata; inversione Ksenia gestita |
| termostato | `Thermostat` | setpoint/mode/temperature | appropriata quando la registrazione riesce |
| termostato fallback | `TemperatureSensor` | sola misura | degradazione lecita ma non controllabile |
| temperatura/umidità/lux/motion/contact | relativo sensore Matter | measurement/state | appropriata; Alexa non espone ogni capability allo stesso modo |
| zona | `ContactSensor` | `BooleanState` | coerente per stato aperto/chiuso |
| scenario | `OnOffPlugInUnit` | `OnOff` server; auto-off dopo 500 ms | comandabile ma semanticamente falso |
| cancello | `OnOffPlugInUnit` | impulso `On`; `Off` no-op | comandabile ma non è né presa né porta nativa |

La scelta scenario/cancello è deliberata nel [mapper, righe 249–270](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/platform/matter-device-mapper.ts#L249-L270): un Generic Switch Matter è un generatore di eventi, non un attuatore vocale universale, e Alexa oggi gli associa `SimpleEventSource`; una presa ottiene invece `PowerController`. Le categorie sono elencate nella [matrice Matter di Alexa](https://www.developer.amazon.com/docs/alexaplus/smarthome/supported-matter-device-categories.html). `[Codice][Alexa]`

È quindi un workaround comprensibile, non un errore ingenuo. Il costo è NLU: Alexa vede una presa da accendere/spegnere, mentre i nomi iniziano già con `Apri`, `Chiudi`, `Inserisci`, `Spegni`. Per un cancello, una Smart Home Skill potrebbe usare un modello porta/garage con semantica open/close; per gli scenari una capability cloud/evento sarebbe più naturale, ma introdurrebbe un'intera infrastruttura aggiuntiva. I [device template Alexa](https://developer.amazon.com/docs/alexaplus/smarthome/get-started-with-device-templates.html) mostrano le capability previste. `[Alexa]`

### B.6 Comando: dal controller al pannello

Il callback Matter chiama `switchLight`, `moveCover`, `toggleGate` o `triggerScenario`. Questi metodi inviano `CMD_USR`, ma non passano `awaitResponse: true` a [`sendKseniaCommand`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/websocket-client/command-service.ts#L249-L287). Di conseguenza:

- la Promise termina dopo la scrittura WebSocket;
- `Light/Cover/Gate command sent` e `Scenario executed` non significano `RESULT=OK`;
- un `_RES` negativo non è correlato a una richiesta pendente;
- a livello log normale il fallimento può sparire;
- Matter/Alexa può ricevere successo anche se il pannello ha rifiutato l'azione.

In più, [`resolvePendingCommand`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/websocket/command-dispatcher.ts#L65-L88) risolve una risposta compatibile senza validare `PAYLOAD.RESULT` o `RESULT_DETAIL`. Anche attivando l'attesa, una risposta `FAIL / CMD_NOT_AVAILABLE` potrebbe essere trattata come successo. `[Codice]`

Questa non è un'ipotesi teorica: [issue #1](https://github.com/paolo-trivi/homebridge-plugin-klares4/issues/1) contiene proprio una risposta `CMD_NOT_AVAILABLE` su scenario mentre il livello applicativo lo dichiarava eseguito. L'issue portò alla classificazione di alcuni output come gate, ma non contiene una conferma finale del reporter sul caso scenario. `[Issue]`

I 29 comandi luce/tapparella del log mostrano attività e aggiornamenti di stato, ma non provano che ciascun comando sia stato accettato. Nessun comando cancello, scenario o termostato è presente nella finestra: questi percorsi restano non verificati in produzione.

### B.7 Termostati degradati

I sei termostati correnti (`thermostat_18`, `19`, `20`, `21`, `22`, `34`) sono registrati come `TemperatureSensor`; quindi Alexa può leggerne la temperatura ma non impostare setpoint o modalità. `[Runtime]`

Il costruttore carica il marker persistente, e la registrazione sceglie subito il fallback per un UUID marcato. Il marker viene rimosso soltanto dopo una registrazione riuscita come vero Thermostat; quel tentativo, però, non avviene più proprio perché il marker forza il fallback. Si vedano [`matter-accessory-registry.ts`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/platform/matter-accessory-registry.ts#L68-L71) e la selezione del fallback nello stesso file. `[Codice]`

È un bug certo di recovery “sticky”. **Non va risolto cancellando manualmente lo store**: un cambio di device type/topologia davanti a controller già accoppiati richiede retry controllato, rollback e verifica.

### B.8 `roomMapping` e `matterExposure`

`roomMapping` viene consumato dal bridge MQTT, non dal mapper Matter ([`mqtt-bridge/index.ts`](https://github.com/paolo-trivi/homebridge-plugin-klares4/blob/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d/src/mqtt-bridge/index.ts#L133-L159)). Matter offre gruppi/EndpointLists nell'Actions cluster e suggerisce ai bridge di esporre il grouping, ma l'attuale superficie plugin di Homebridge non fornisce qui una semplice proiezione delle stanze. `[Codice][Matter][Homebridge]`

Perciò Alexa deve ricevere/configurare le stanze dal proprio controller. Non è un bug del naming, ma significa che il plugin non può controllare collisioni fra `NodeLabel` e nomi dei gruppi Alexa.

`matterExposure` opera invece prima della registrazione Matter:

- nascondere zone/sensori riduce l'inventario Alexa senza modificare HAP/Siri;
- nascondere tutte le zone elimina molti shadow `Pulsante X`/`X` e `Finestra X`/contact;
- nascondere tutti i sensori sacrifica query vocali di temperatura, umidità e contatto;
- i lux sensor hanno oggi utilità Alexa limitata perché la matrice ufficiale non assegna una capability al Light Sensor;
- l'impostazione è per categoria, non per singola entità o singolo controller.

Poiché la topology appartiene al Matter node, la stessa esclusione vale anche per Google Home e SmartThings se sono commissionati sul medesimo bridge: entrambi perdono quegli endpoint, il loro stato e la possibilità di usarli nelle automazioni. Siri continua invece a vederli quando usa il percorso HAP/HomeKit separato. L'effetto concreto delle capability sui controller Google/SmartThings dipende dalle relative versioni, ma la scomparsa dell'endpoint è deterministica. `[Matter][Inferenza]`

La configurazione corrente è quindi sensata come mitigazione voice-first, ma troppo grossolana come soluzione finale.

## C. Problemi classificati

### C.1 Bug certi

| Problema | Prova | Impatto |
|---|---|---|
| I comandi mutativi non attendono `CMD_USR_RES` | `[Codice][Issue]` | falso successo verso Matter/Alexa; fallimenti invisibili |
| `RESULT=FAIL` non viene validato dal dispatcher | `[Codice]` | anche un futuro ACK atteso può risultare successo |
| fallback termostato persistente non ha percorso autonomo di recovery | `[Codice][Runtime]` | sei termostati restano sensori read-only indefinitamente |
| unregister/register considerato completato troppo presto | `[Codice][Homebridge]` | race di rinomina/topologia e stato interno troppo ottimistico |
| loader name-map non valida invarianti/versione | `[Codice]` | nomi corrotti/duplicati possono essere seminati nel registro |
| fallback UUID incrementale non ricontrolla collisioni e conserva `_` | `[Codice][Test]` | rara collisione o violazione dell'invariante dichiarata |

### C.2 Rischi architetturali

| Rischio | Conseguenza |
|---|---|
| `sourceName`, override e nome finale non sono fatti separati | impossibile spiegare e auditare in modo affidabile la trasformazione |
| Unicità lessicale equiparata a voice safety | una mappa senza duplicati può restare fortemente ambigua per NLU |
| Scenari/gate simulati come prese | capacità disponibile, semantica e verbi non allineati |
| Ri-registrazione usata come meccanismo di rename | churn topologico e dipendenza da comportamento controller non garantito |
| `roomMapping` fuori dalla pipeline Matter | nessuna prevenzione delle collisioni con stanze/gruppi controller |
| memoria del tipo output soltanto in-process | al cold start un output ambiguo può essere classificato prima di avere contesto sufficiente |
| log per-device molto verbosi a ogni boot | riducono la finestra utile proprio quando serve osservare stabilità lunga |

### C.3 Comportamenti Alexa/controller, non controllabili dal solo plugin

- trascrizione ASR della frase italiana;
- risoluzione NLU fra stanza, device, gruppo, scena e intenti built-in;
- aggiornamento dell'indice dopo cambio `NodeLabel`;
- retention di endpoint rimossi e alias precedenti;
- rinomina fatta dall'utente nell'app Alexa;
- differenze fra Echo/hub, app e firmware controller;
- `AddOrUpdateReport` cloud, disponibile a una Smart Home Skill ma non a un endpoint Matter locale. La documentazione Alexa richiede questo flusso per aggiornamenti cloud di nome/capability: [Discovery e AddOrUpdateReport](https://www.developer.amazon.com/docs/alexaplus/smarthome/discovery.html). `[Alexa]`

### C.4 Miglioramenti, non bug

- scoring di collisione vocale locale-aware;
- override solo Matter, separato dal nome HAP;
- allow/deny Matter per UUID e preset `voice-first`;
- report di diagnostica generato dalla stessa SSOT dei nomi;
- metriche ACK/timeout/state-confirmed;
- workflow esplicito di rename/resync con stato `published-unverified`;
- test del fixture per collisioni near/semantic/room/cross-type, non solo exact duplicate.

### C.5 Non-problemi o scelte corrette

- UUID basato su ID Klares: protegge l'identità attraverso le rinomine;
- mappa persistente e reservation window: riducono name churn;
- priorità degli attuatori rispetto ai passivi nelle collisioni esatte;
- `WindowCovering`, light e tipi sensore sono mappature sensate;
- nascondere da Matter non elimina da HAP;
- non poter osservare il friendly name interno ad Alexa non è un difetto correggibile nel plugin;
- l'assenza di duplicati esatti nella mappa finale è vera, ma non equivale a “nessuna collisione vocale”.

## D. Top 5 root cause dei sintomi vocali

Distribuzione euristica che somma a 100%, utile per decidere l'ordine dei test:

| # | Root cause candidata | Probabilità | Perché |
|---:|---|---:|---|
| 1 | namespace semantico: stanze/gruppi, verbi nel nome, intenti globali | **30%** | 8 luci coincidono con stanze; `Spegni Tutto` e nomi verbo-oggetto competono con comandi naturali |
| 2 | scenari/gate rappresentati come `OnOffPlugInUnit` | **25%** | Alexa tenta la grammatica di una presa, non open/close o scene; il nome contiene già il verbo |
| 3 | comando Klares non confermato o rifiutato | **20%** | il plugin restituisce successo alla sola scrittura socket; un fallimento reale sembra un errore di risoluzione vocale |
| 4 | indice/cache Alexa non aggiornato dopo pruning/rename | **15%** | 42 notifiche parts-list fallite; il controller non conferma mai il nome osservato |
| 5 | collisioni lessicali near/abbreviazioni e vecchi endpoint passivi | **10%** | il resolver attuale non le rileva; l'esposizione 53/109 le riduce, ma eventuali ghost Alexa possono mantenerle |

La quota non include il fallback dei termostati: quello è un difetto certo, ma spiega una capability mancante, non la maggior parte dei nomi mal risolti.

## E. Analisi voice-first delle 109 entità

### E.1 Risultato del naming corrente

Su 109 nomi, la mappa cambia soltanto sei collisioni esatte, tutte coppie tapparella/zona:

| Entità passiva | Nome finale Matter |
|---|---|
| `zone_18` | `Finestra Studio - Sens.` |
| `zone_19` | `Finestra Cucina - Sens.` |
| `zone_22` | `Finestra Bagno - Sens.` |
| `zone_24` | `Finestra Matrimoniale - Sens.` |
| `zone_25` | `Finestra Bagno Matrimoni - Sens.` |
| `zone_26` | `Finestra Cameretta - Sens.` |

`Finestra Cab. Armadio` e `Finestra Cabina Armadio` non sono viste come collisione, pur essendo equivalenti o molto vicine nel parlato. I test coprono il caso exact e accettano questa differenza. `[Test]`

Con l'esposizione corrente le zone e i sensori non sono live, quindi queste sei collisioni e gran parte del rumore passivo sono eliminate dal nuovo inventario. Restano però 53 endpoint, 20 dei quali modellati come prese momentanee e 6 come temperature sensor di fallback.

### E.2 Proposta di `voiceCollisionScore`

Lo scorer deve essere diagnostico e deterministico; non deve rinominare automaticamente.

**Fatti in ingresso, dalla SSOT:** `uuid`, `sourceName`, `customName`, `sanitizedBase`, `finalMatterName`, `deviceType`, `matterDeviceType`, `exposed`, eventuali `roomNames`, provenienza dei suffissi e limite/troncamento.

**Normalizzazione italiana v1:**

1. Unicode NFKC, trim, whitespace collapse, lowercase `it-IT`;
2. punctuation → spazio e una seconda vista deaccentata per fuzzy matching;
3. espansioni esplicite: `sens→sensore`, `tapp→tapparella`, `term→termostato`, `cab→cabina`, `balc→balcone`, `matrim→matrimoniale`, `tv→televisione`;
4. dizionario limitato singolare/plurale: luce/luci, finestra/finestre, tapparella/tapparelle, sensore/sensori, cancello/cancelli, scenario/scenari, termostato/termostati, volumetrico/volumetrici;
5. rimozione di un suffisso artificiale solo se la provenance conferma che è stato aggiunto dal plugin;
6. articoli/preposizioni a peso basso, ma verbi d'azione conservati;
7. sinonimi di dominio a peso ridotto: luce/lampada, tapparella/serranda, cancello/cancelletto.

Non introdurrei Soundex o una “fonetica italiana” opaca nella v1: la vista deaccentata più edit distance è un proxy verificabile; la fonetica vera va calibrata sulla trascrizione della cronologia vocale Alexa.

**Anchor e modificatori:**

```text
base = max(
  exact=100,
  sameRootAfterArtificialSuffix=94,
  equalsRoomOrGroup=93,
  scenarioVerbPlusEntity=92,
  abbreviationOrSingularEquivalent=88,
  fullTokenPrefix=76,
  tokenContainment=58,
  fuzzySimilarity=round(60 * similarity)
)

score = min(100, base
  + 8 if active/passive shadow
  + 6 if cross-type but capability-compatible
  + 8 if truncation altered a distinguishing token
  + 5 if one side is a room/group or generic one-word target)
```

Gating evita confronti inutili: stessa capability, active/passive dello stesso oggetto, scenario verbo+oggetto, oppure device contro stanza/gruppo. Soglie: `CRITICAL ≥90`, `HIGH 70–89`, `MEDIUM 45–69`, `LOW 25–44`; sotto 25 non si emette un finding.

### E.3 Tabella collisioni ordinate per rischio

Le righe aggregate indicano famiglie omogenee; il numero fra parentesi è il numero di coppie reali. `Live` descrive la configurazione Matter attuale, non eventuali ghost già indicizzati da Alexa.

| Score | Risk | Entity A | Type A | Entity B / namespace | Type B | Reason | Live |
|---:|---|---|---|---|---|---|:---:|
| 100 | CRITICAL | `Spegni Tutto` | scenario / plug | “spegni tutto” | intento globale | exact frase comando; può mirare una presa-scenario o tutta la casa | sì |
| 100 | CRITICAL | `Cucina`, `Lavanderia`, `Studio`, `Bagno`, `Matrimoniale`, `Bagno Matrimoniale`, `Cameretta`, `Corridoio` (8) | light | stanze/gruppi omonimi | controller room/group | exact room equality | sì |
| 100 | CRITICAL | `Finestra <stanza>` (6) | zone / contact | tapparella omonima | cover | stessa radice; `- Sens.` non rende la frase naturale distinta | no |
| 100 | CRITICAL | `Finestra Cab. Armadio` | zone / contact | `Finestra Cabina Armadio` | cover | abbreviazione equivalente, non intercettata | zona no |
| 98 | CRITICAL | `Cancello` | gate / plug | `Apri Cancello` | scenario / plug | scenario verb+entity; la frase coincide col nome completo dello scenario | sì |
| 93 | CRITICAL | `Finestra Bagno Matrimoniale - Sens.` | zone / contact | `Finestra Bagno Matrimoniale` | cover | troncamento a `Matrimoni` riduce il token distintivo | no |
| 92 | CRITICAL | `Pulsante <luce>` (circa 13) | zone / contact | luce target corrispondente | light | tolto il generico “pulsante”, resta lo stesso target | no |
| 88 | HIGH | `Attiva allarme` | light | sicurezza/allarme | intento controller | device light con nome imperativo e dominio incongruente | sì |
| 84 | HIGH | `Apri Cancello` | scenario / plug | `Apri Cancello Grande` | scenario / plug | full prefix e stessa capability | sì |
| 82 | HIGH | `Cancello` | gate / plug | `Comando Cancelletto` | scenario / plug | sinonimo/near-phonetic e stesso oggetto fisico possibile | sì |
| 80 | HIGH | `Balcone Sala` | cover | `Balcone Sala Centrale` | cover | full prefix | sì |
| 80 | HIGH | `Finestra Bagno` | cover | `Finestra Bagno Matrimoniale` | cover | full prefix | sì |
| 80 | HIGH | `Bagno` | light | `Bagno Matrimoniale` | light | full prefix, oltre alla collisione con stanze | sì |
| 78 | HIGH | `Faretti` | light | `Faretti Televisione` | light | full prefix e target generico | sì |
| 78 | HIGH | `Inserisci Finestre` | scenario / plug | `Inserisci Finestre e Tapparelle`, `...e Volumetrici` | scenario / plug | prefix fra scenari | sì |
| 78 | HIGH | `Inserisci Tapparelle` | scenario / plug | `Inserisci Tapparelle e Volumetri` | scenario / plug | prefix fra scenari | sì |
| 76 | HIGH | `Apri/Chiudi/Spegni Zona Giorno` | scenario / plug | stessa terna `Zona Notte` | scenario / plug | differiscono solo verbo o ultimo token; grammatica d'azione nel nome | sì |
| 75 | HIGH | `Tapparella <stanza>` (almeno 7) | zone / contact | `Finestra <stanza>` | cover | diverso sostantivo, stesso oggetto/stanza | no |
| 72 | HIGH | `Pulsante Corridoio 1/2` | zone / contact | `Corridoio` | light/room | prefix e numerale finale debole nel parlato | no |
| 60 | MEDIUM | `TV` / token abbreviati | mixed | `Faretti Televisione` e nomi estesi | mixed | espansione abbreviazione + containment | misto |
| 56 | MEDIUM | `Temperatura/Umidità/Luminosità <stanza>` | sensors | membri della stessa tripletta | sensors | stesso locale; la misura esplicita normalmente disambigua | no |
| 52 | MEDIUM | `Temperatura Interna/Esterna` | sensors | `Riscaldamento/Raffrescamento <stanza>` | thermostat fallback | stessa stanza e dominio clima, tipi diversi | sensori no; fallback sì |

Non emerge una coppia singolare/plurale letterale significativa nel fixture corrente; la regola è comunque necessaria per impedire regressioni future. Allo stesso modo, una misura fonetica affidabile richiede le trascrizioni Alexa: senza quelle, “fonetico” resta un'approssimazione e va dichiarato.

### E.4 Opzioni di intervento

| # | Opzione | Beneficio | Rischio | Complessità | Alexa | Siri/HAP | Raccomandata |
|---:|---|---|---|---|---|---|:---:|
| 1 | Nascondere zone/sensori Matter | alto sul rumore; già 109→53 | perdita query/automazioni sensori su controller Matter | bassa | molto positivo per risoluzione; perdita funzionale selettiva | invariata via HAP | **sì, con granularità** |
| 2 | Nuova strategia nomi | alto se mirata a conflitti provati | cache controller, regressione abitudini vocali | media | positivo | nullo se override Matter-only | **sì** |
| 3 | Analizzatore voice-first | alto per prevenzione/diagnosi | falsi positivi se score opaco | media | indiretto | nessuno | **sì, subito** |
| 4 | Esposizione per controller/ecosistema nello stesso bridge | teorico | falso senso di isolamento; topologia è del node/fabric | alta/non supportata così | incerto | incerto | **no** |
| 5 | Bridge Matter dedicato voice-first | isolamento forte e inventario minimale | nuovo commissioning, duplicati, più connessioni/stato | alta | positivo se ben gestito | HAP esistente preservato | non ora |
| 6 | Custom Alexa Smart Home Skill | semantica/alias/eventi cloud migliori | cloud, OAuth, security, certification, costi e manutenzione | molto alta | massimo potenziale | nessun beneficio | solo ultima istanza |
| 7 | Profilo voice-first + include/exclude per UUID + correctness/observability | beneficio massimo senza re-pair | migrazione config e disciplina SSOT | media | molto positivo | invariata | **migliore** |

#### Opzione 1 — nascondere zone/sensori

Mantenere `zones=false` è appropriato per l'obiettivo attuale. Per i sensori, passerei dal flag tutto/niente a una allowlist: esporre solo temperature/umidità utili e con nome deliberato, nascondere lux non supportati vocalmente e contatti duplicati dalle tapparelle. La matrice Alexa indica che contact, temperature e humidity hanno capability utilizzabili, mentre Light Sensor non ne ha una associata. `[Alexa]`

#### Opzione 2 — strategia nomi

Regole pratiche:

- il nome Matter deve essere un sostantivo identificabile, non un'intera frase imperativa;
- non deve uguagliare il nome della stanza/gruppo;
- il token distintivo deve stare presto e sopravvivere ai 32 caratteri;
- evitare abbreviazioni arbitrarie (`Sens.`, `Cab.`, `Matrim.`) nei nomi vocali;
- non affidarsi al suffisso di tipo per separare due rappresentazioni dello stesso oggetto;
- mantenere un override Matter-only, lasciando invariati pannello e HAP;
- rinominare soltanto finding `CRITICAL/HIGH` confermati dal test Alexa.

Esempi indicativi, da validare sulla voce: luce `Studio` → `Lampadario Studio`; scenario `Spegni Tutto` → un nome nominale unico come `Assetto Casa Spenta`; scenario `Apri Cancello` → esporre un solo endpoint operativo per quel varco, non inventare due sinonimi concorrenti. Le linee guida Alexa consigliano friendly name semplici e non duplicati e l'aggiornamento proattivo in un'integrazione cloud: [best practice Alexa Smart Home](https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2021/06/best-practices-for-controlling-devices-with-smart-home-skills). `[Alexa]`

#### Opzione 3 — analizzatore

Deve girare dopo la costruzione della mappa finale e prima della registrazione, in modalità read-only:

- `INFO`: conteggi, distribuzione severity, top 5, hash della diagnosi;
- `WARN`: solo nuovi finding `CRITICAL/HIGH`, una volta per hash;
- `DEBUG` o export esplicito: tabella completa con ragioni;
- mai modifica automatica dei nomi;
- test snapshot sul fixture 109, più casi Unicode, truncation, abbreviazioni, singolare/plurale, room e cross-type.

#### Opzione 4 — per controller

Non la implementerei come semplice flag. Un singolo Matter node espone la sua endpoint topology alle fabric commissionate; ACL e fabric non equivalgono a un catalogo nomi diverso per Alexa rispetto a un altro controller. Per avere inventari realmente diversi servono node/bridge distinti, con commissioning separato.

#### Opzione 5 — bridge voice-first dedicato

È tecnicamente concepibile come seconda istanza/node che espone solo gli endpoint Alexa. Ma l'inventario corrente è già ridotto a 53, e un secondo bridge moltiplica pairing, diagnostica, possibili doppi comandi e lifecycle. Lo valuterei solo se, dopo le correzioni e un resync controllato, Alexa continuasse a non recepire la topologia desiderata.

#### Opzione 6 — custom Alexa Smart Home Skill

È l'unico percorso che dà pieno controllo su discovery cloud, alias, capability specifiche e `AddOrUpdateReport`. Può modellare un cancello come porta/garage e gli scenari con una semantica più naturale. Ma richiede backend always-on, account linking/OAuth, gestione credenziali Klares, policy privacy/security, Lambda o equivalente, test/certificazione e manutenzione della API Alexa. È sproporzionata finché Matter non è stato prima reso corretto e misurabile.

#### Opzione 7 — soluzione migliore

Una sola funzione `isMatterExposed(device, config)` deve essere SSOT e combinare:

- preset opzionale `voice-first`;
- categorie esistenti;
- `includeMatterUUIDs` / `excludeMatterUUIDs` per eccezioni;
- override nome Matter per UUID;
- analisi collisioni sulla lista **effettivamente esposta**;
- nessun cambiamento di default per installazioni esistenti.

Sul tuo impianto consentirebbe di mantenere le zone nascoste, riattivare soltanto pochi sensori utili, scegliere uno fra endpoint cancello/scenario duplicati e correggere le 8 luci omonime alle stanze senza toccare Siri/HAP.

## F. Raccomandazione finale

### Minimo sicuro adesso

1. Conservare l'attuale pairing, storage Matter, UUID e `zones=false`/`sensors=false`.
2. Non cancellare `klares4-matter-fallback.json` e non forzare i sei termostati.
3. Eseguire la matrice di test Alexa della sezione H, soprattutto app-tap versus voce e trascrizione.
4. Decidere un solo endpoint per il cancello principale: `gate_29` oppure lo scenario omologo, in base a quale comando Klares è realmente valido.
5. Evitare per ora di pronunciare `Spegni Tutto` come test non controllato: potrebbe spegnere il gruppo globale.

### Intervento raccomandato

1. Correggere ACK, risultato e timeout dei comandi prima di attribuire ogni “non risponde” ad Alexa.
2. Aggiungere `voiceCollisionScore` e provenance dei nomi senza cambiare output.
3. Introdurre override Matter-only e include/exclude per UUID, backward-compatible.
4. Applicare rinomine soltanto agli 8 conflitti stanza/luce e ai nomi imperativi/duplicati confermati.
5. Rendere il fallback termostati recuperabile con workflow controllato e rollback.
6. Seriare e verificare il lifecycle delle rinomine; se Homebridge non consente un ACK reale, registrare lo stato come `published-unverified`.

### Ideale dopo il live test

- una settimana di metriche con command outcome, reconnect, endpoint count e memoria del child bridge;
- 7–14 giorni di soak su release stabile, non RC;
- procedura controller-resync documentata e non distruttiva;
- solo se resta una limitazione Alexa strutturale: bridge Matter dedicato; Skill custom soltanto come ultima opzione.

### Cosa non fare

- uninstall/reinstall del plugin o rigenerazione del bridge come primo tentativo;
- cancellazione massiva di cache, name-map, fallback store o fabric;
- cambio UUID per forzare la discovery;
- unregister/register in massa ad ogni boot;
- rinomina automatica fonetica di 109 entità;
- passaggio a Generic Switch aspettandosi controllo vocale universale;
- cambiare i default globali del plugin e nascondere sensori a tutti gli utenti;
- affermare dai log “scenario eseguito” prima di un ACK valido e, quando possibile, dello stato osservato.

## G. Piano di implementazione in commit piccoli

Nessuno di questi commit è stato applicato durante l'audit.

| # | Commit | File/funzioni principali | Test richiesti | Rischio regressione |
|---:|---|---|---|---|
| 1 | `fix(websocket): validate mutation acknowledgements` | `src/websocket-client/command-service.ts`: `switchLight`, `moveCover`, `toggleGate`, `triggerScenario`, `sendKseniaCommand`; `src/websocket/command-dispatcher.ts`: validazione outcome; tipi/errore protocollo | OK/FAIL/timeout, ID exact/fallback, più comandi concorrenti, `CMD_NOT_AVAILABLE`, nessun pending leak | **medio**: varianti firmware Klares |
| 2 | `test(commands): cover Matter-to-panel outcomes` | test mapper/accessory + nuovi test command service | callback Matter rigetta su FAIL/timeout e non su OK; conferma che log non dica executed prematuramente | basso |
| 3 | `fix(matter): make thermostat fallback recoverable` | `matter-fallback-store.ts`, `matter-accessory-registry.ts`, `matter-registration-recovery.ts`; marker con reason/attempts/nextRetry/version | store v1 migration, bounded retry, rollback, stesso UUID, no loop ad ogni boot | **alto**: mutazione device type/topologia |
| 4 | `fix(naming): harden persisted name invariants` | `matter-name-store.ts`, `matter-name-map.ts`, `matter-name-sanitizer.ts` | schema/version, duplicate seed, Unicode NFKC, >32, invalid chars, suffisso UUID unico, legacy compatibility | medio: rare correzioni nome |
| 5 | `refactor(naming): preserve name provenance` | tipi discovery, `applyCustomName`, mapper; nuovo `ResolvedDeviceNames` | source/custom/sanitized/final distinti, HAP/MQTT invariati, serialization order | medio |
| 6 | `feat(matter): add deterministic voice collision analysis` | nuovi `voice-name-normalizer.ts`, `matter-voice-analyzer.ts`, relativi tipi; mantenere ogni modulo focalizzato | fixture 109, exact, room, prefix, abbreviation, singular, cross-type, truncation, Unicode, determinismo | basso: read-only |
| 7 | `feat(observability): report voice and command truth` | integrazione in name finalizer e command service; summary/hash/metrics | dedup warning, redaction, cardinalità, controller name sempre `unknown` | basso |
| 8 | `feat(config): add opt-in voice-first Matter policy` | config schema/types/UI, unica `isMatterExposed`; override Matter name e include/exclude UUID | default invariato, precedence, 53 inventory fixture, HAP invariato, invalid UUID/name | medio |
| 9 | `fix(matter): serialize and verify rename lifecycle` | `matter-name-finalizer.ts`, registry, register probe; coda/coalescing | old endpoint removed prima del nuovo, retry bounded, restart mid-flight, same UUID, no mass churn | **alto**: Homebridge/Matter timing |
| 10 | `chore(release): dependency audit and stable soak` | dependency/lock, workflow, release docs | Node 20/22/24, 244+ test, build, npm audit prod, 7–14 giorni canary | basso/medio |

### Dettaglio commit 1: definizione di successo

Un risultato strutturato dovrebbe distinguere:

```ts
type CommandOutcome =
  | { status: 'acknowledged'; responseType: string; latencyMs: number }
  | { status: 'rejected'; code?: string; detail?: string; latencyMs: number }
  | { status: 'timeout'; timeoutMs: number };
```

Le API pubbliche restano `Promise<void>` se si vuole minimizzare la superficie: risolvono soltanto su `acknowledged`, altrimenti lanciano errori tipizzati. Il dispatcher deve correlare per ID quando possibile; il fallback “unico comando compatibile” va mantenuto soltanto se la variante firmware lo richiede ed è non ambigua. La conferma realtime dello stato è un livello distinto (`state_confirmed`), non va confusa con l'ACK.

### Dettaglio commit 3: recovery termostati

Lo store non deve essere un `Set<uuid>` eterno, ma record versionati:

```ts
interface MatterFallbackRecord {
  uuid: string;
  reason: string;
  attempts: number;
  lastFailureAt: string;
  nextRetryAt?: string;
  pluginVersion: string;
}
```

Un retry può avvenire soltanto con backoff, limite tentativi e rollback atomico al TemperatureSensor se il Thermostat non diventa queryable. Per ridurre il rischio, il primo rilascio può esporre un'azione amministrativa esplicita per UUID invece di fare sei conversioni automatiche.

### Dettaglio commit 8: precedence config

Una precedenza semplice evita due SSOT:

```text
explicit exclude UUID
  > explicit include UUID
  > category flag
  > selected preset
  > backward-compatible default
```

Gli override nome devono essere indicizzati dall'UUID completo e validati dalla stessa funzione del runtime; non creare una seconda lista di nomi soltanto per il report.

## H. Questions requiring a live Alexa test

Questi test sono le sole domande che il codice e i log non possono chiudere.

### H.1 Baseline inventory e ghost

Nell'app Alexa:

1. quanti dispositivi Klares/Matter sono visibili: 53 o un numero maggiore?
2. esistono ancora zone `Pulsante ...`, sensori, oppure nomi `... - Sens.`?
3. per `Cancello`, `Apri Cancello` e `Spegni Tutto`, quale tipo mostra l'app?
4. i sei `Riscaldamento/Raffrescamento` sono mostrati come sensori temperatura o termostati?

Se Alexa mostra >53 endpoint, la prima indagine è cache/pruning, non una nuova rinomina.

### H.2 Separare ASR, NLU e trasporto

Per ogni frase annotare: trascrizione nella cronologia Alexa, risposta vocale, endpoint selezionato, azione fisica, riga plugin.

| Test | Cosa distingue |
|---|---|
| tap dall'app su un endpoint, poi stessa azione a voce | se falliscono entrambi: tipo/ACK/pannello; se fallisce solo la voce: ASR/NLU/nome |
| `accendi Studio` e `accendi Lampada Studio` | collisione stanza versus device |
| `chiudi Finestra Studio` | verifica che il cover sia target unico dopo aver nascosto la zona |
| `apri Cancello`, `accendi Cancello`, `accendi Apri Cancello` | grammatica open/close versus PowerController e duplicato gate/scenario |
| `apri Cancello Grande` | prefix con lo scenario corto |
| query della temperatura di una stanza | distinguere sensore fallback/room resolution |
| stesso endpoint da Siri/HAP e Alexa/Matter | pannello/plugin comune versus controller specifico |

Il test `Spegni Tutto` va fatto solo in una finestra sicura e con la possibilità di ripristinare i carichi: la frase potrebbe correttamente attivare il comando globale di Alexa.

### H.3 Un solo rename controllato

Scegliere una luce non critica omonima a una stanza, applicare un override Matter-only e osservare:

- nome nell'app Alexa a 0, 5, 15 e 60 minuti;
- funzionamento del nome nuovo e del vecchio;
- endpoint count invariato e stesso UUID;
- presenza di warning `parts list change`;
- comportamento dopo un solo restart senza altre modifiche.

Questo misura la cache reale. Non usare cancello, allarme, sirena o termostati come cavia, e non fare otto rename contemporanei.

### H.4 Gate/scenari e ACK

Dopo il commit ACK, raccogliere per almeno un comando di ciascun tipo:

- `sent_at`, `response_at`, `RESULT`, `RESULT_DETAIL`, latenza;
- stato realtime successivo, se esiste;
- esito fisico verificato;
- frase e trascrizione Alexa.

Solo allora si può decidere se esporre `gate_29`, `scenario_14`, entrambi o nessuno. Oggi il log non contiene una prova sufficiente.

## I. Osservabilità e SSOT

### I.1 Naming

Per ogni endpoint, solo in debug/export:

```text
uuid, sourceName, customName, sanitizedBase, finalMatterName,
deviceType, matterDeviceType, exposedToMatter,
nameState=requested|published-unverified|locally-queryable,
controllerObservedName=unknown,
collisionScore, collisionReasons, diagnosticHash
```

`controllerObservedName` deve restare `unknown`: valorizzarlo col nome richiesto creerebbe telemetria falsa. In `INFO` basta una riga come `53 exposed; 2 critical; 6 high; hash=...`; l'elenco completo ad ogni boot accorcia inutilmente la retention.

### I.2 Comandi

```text
commandId, deviceUuid, commandKind,
queuedAt, sentAt, ackAt, outcome,
panelCode, latencyMs, stateConfirmedAt
```

Mai loggare PIN, QR Matter, token, payload di login o indirizzi non necessari. Le metriche minime sono contatori `ack_ok`, `ack_fail`, `timeout`, `state_confirmed`, reconnect e gauge endpoint per tipo; evitare label col nome dispositivo per non esplodere la cardinalità.

### I.3 Persistenza

Non creare un nuovo file persistente che dupli la mappa. La diagnosi va calcolata dalla stessa struttura `MatterNameFacts` e può essere esportata su richiesta. Se si estende `klares4-matter-names.json`, usare schema v2 con migrazione e provenance minima; il report rimane una vista derivata.

## J. Salute del progetto e issue GitHub

### J.1 Qualità verificata

- `npm ci`, build TypeScript e **244/244 test** superati sul tag esatto, Node 22. `[Test]`
- la CI testa Node 20/22 e il release workflow Node 24; le esecuzioni recenti sono verdi nella pagina [GitHub Actions](https://github.com/paolo-trivi/homebridge-plugin-klares4/actions). `[CI]`
- non esiste uno script lint effettivo: `npm run lint --if-present` non è una prova di linting. `[Codice]`
- `main` è divergente dal tag soprattutto per lock/dependency update; verificare il [compare tag…main](https://github.com/paolo-trivi/homebridge-plugin-klares4/compare/v2.1.5-rc.1...main). `[Repository]`

### J.2 Release e supporto

Il runtime usa la RC [v2.1.5-rc.1](https://github.com/paolo-trivi/homebridge-plugin-klares4/releases/tag/v2.1.5-rc.1); il dist-tag npm stabile rilevato è `2.1.4`. La RC contiene proprio rinforzi a name reservation e pruning, quindi tornare indietro alla cieca non è consigliabile; va invece promossa stabile dopo soak e test live. `[Release]`

Il tracker ha pochi segnali utente utilizzabili. Le issue aperte includono rumore/test Sentry e PR bot; [issue #37](https://github.com/paolo-trivi/homebridge-plugin-klares4/issues/37) riguarda TLS legacy, mentre [issue #11](https://github.com/paolo-trivi/homebridge-plugin-klares4/issues/11) descrive una connessione chiusa senza conferma finale del reporter. L'assenza di issue aperte serie non è evidenza statistica di stabilità: repository giovane, 8 star e base utenti osservabile piccola. `[Issue][Inferenza]`

### J.3 Dipendenze

L'audit production del tag segnala una catena high in `mqtt → socks → ip-address 10.2.0`, [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), corretta dalle versioni successive. MQTT è disabilitato nell'impianto osservato, quindi il percorso è inattivo ma la dipendenza rimane distribuibile. Va aggiornata e verificata nella prossima release, senza trasformare questo finding in causa dei problemi Alexa. `[Security][Runtime]`

## K. Verdetto

Il plugin non mostra crash o disconnessioni anomale nella finestra disponibile e possiede una buona base di test, UUID stabili e naming deterministico. Non lo definirei però ancora “stabile end-to-end”: la retention è troppo corta, la release è RC, 42 notifiche topologiche sono fallite, i comandi mutativi dichiarano successo senza ACK e sei termostati sono bloccati nel fallback.

Per Alexa, nascondere zone/sensori è stata una mitigazione utile ma non definitiva. Il salto di qualità non è un algoritmo che inventa nomi: è rendere verificabile la catena **nome sorgente → nome Matter → endpoint realmente pubblicato → comando ACK → stato fisico**, poi correggere soltanto le collisioni ad alto rischio. Questo preserva HomeKit/Siri, evita un re-pair distruttivo e lascia una via chiara verso un bridge dedicato o una Skill solo se i test dimostrano un limite reale del controller.

## Fonti primarie principali

- [Repository e README del plugin](https://github.com/paolo-trivi/homebridge-plugin-klares4)
- [Codice del tag analizzato](https://github.com/paolo-trivi/homebridge-plugin-klares4/tree/92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d)
- [Homebridge 2.4.0 — MatterAPIImpl](https://github.com/homebridge/homebridge/blob/v2.4.0/src/matter/MatterAPIImpl.ts)
- [Matter Core Specification 1.6](https://csa-iot.org/wp-content/uploads/2026/06/23-27349-011_Matter-1.6-Core-Specification.pdf)
- [Matter Device Type Library Specification 1.6](https://csa-iot.org/wp-content/uploads/2026/06/23-27351-010_Matter-1.6-Device-Library-Specification.pdf)
- [Alexa — categorie Matter supportate](https://www.developer.amazon.com/docs/alexaplus/smarthome/supported-matter-device-categories.html)
- [Alexa — discovery e aggiornamenti endpoint](https://www.developer.amazon.com/docs/alexaplus/smarthome/discovery.html)
