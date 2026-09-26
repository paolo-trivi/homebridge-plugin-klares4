# AUDIT_REPORT — homebridge-plugin-klares4 `2.2.0-rc.3`

Data: 2026-09-26 · Baseline: `3b687f9` (branch `claude/wizardly-newton-ebzrkq`, working tree pulito all'inizio) · Autore: audit automatizzato (Claude Code)

> Nota di metodo: ogni finding sotto è stato verificato leggendo il codice responsabile e seguendone il call path. Quando indicato, è stato riprodotto con uno script o con un test contro `dist/` ricompilato. I comportamenti di Homebridge/matter.js sono stati verificati **nel codice installato** (`homebridge@2.4.0`, `@homebridge/hap-nodejs@2.2.2`, `@matter/*@0.17.9`), non a memoria.

---

# Executive summary

**Stato generale.** Il plugin ha basi solide:

- correlazione comandi rigorosa (ACK positivo oppure conferma di stato, mai "socket write = success");
- persistenza versionata con scrittura atomica per nomi e fallback Matter;
- prune Matter resistente ai partial sync;
- sanitizzazione telemetry con test;
- file facade effettivamente puri.

La suite di partenza (274 test) era verde su Node 20 e 22.

**Il plugin non è però ancora "stable" per uso continuativo con Matter su Homebridge 2.4.** L'audit ha trovato 6 difetti P1 riproducibili:

1. **Ogni unregister Matter era un no-op su Homebridge 2.4.0** *(corretto in questo audit)*. Rename, prune e recovery termostato non avevano mai effetto.
2. **`customNames` viene cancellato dalla Homebridge UI.** È lo stesso difetto già corretto in rc.3 per `matterOverrides`.
3. **A ogni (ri)connessione lo stato reale viene sovrascritto con i default del parser**: luci OFF, tapparelle 0%, 0 °C, termostato OFF. Seguono transizioni spurie verso HomeKit e Matter, che possono far scattare automazioni.
4. **I dimmer sono esposti su Matter sempre come `OnOffLight`**: niente dimmerazione via Matter.
5. **Race di doppia registrazione nella recovery esplicita del termostato.** Ora che l'unregister funziona, è l'ultimo ostacolo alla recovery.
6. **Setpoint del termostato scritto sulla stagione sbagliata**: in estate, dopo un riavvio, le modifiche vengono perse pur riportando successo; con un hint stale la centrale passa da riscaldamento a raffrescamento.

**Finding per severità**

| Severità | Totale | Corretti in questo audit | Aperti |
|---|---|---|---|
| P0 | 0 | 0 | 0 |
| P1 | 8 | 8 | 0 |
| P2 | 16 | 9 | 7 |
| P3 | 16 | 1 | 15 |

Aggiornato dopo la verifica sul campo (vedi *Field verification*): +2 P1 trovati sul campo (F37, F38), +2 P3 (F39, F40). Corretti in questa fase: F02, F03, F04, F05, F06, F14, F22, F37, F38, F40.

**Aree a maggior rischio**

1. Topologia Matter (lifecycle registrazione/unregister, recovery, device type deciso troppo presto).
2. Ciclo di discovery ripetuto a ogni reconnect.
3. Percorso di scrittura dei termostati: stagione, cfg in cache, mapping Matter heat/cool.
4. Schema di configurazione rispetto alla Homebridge UI.
5. Comportamento con pannello offline all'avvio e durante i reconnect.

**Cosa è stato verificato**

- Lettura completa di `src/` (≈11.7k righe), dei test, della CI, dello schema, di CHANGELOG/README/docs EN+IT.
- Verifica diretta del codice Homebridge 2.4.0: `MatterAPIImpl`, `AccessoryManager`, `StateManager`, `cli.js`. Verifiche anche su HAP-NodeJS e mqtt.js 5.16.
- Riproduzioni con script dedicati e 13 nuovi test di regressione.
- Gate di verifica eseguiti su Node 22 e sulla matrice CI Node 20.
- Seconda passata indipendente (vedi sezione dedicata).

**Limiti**

- Nessun pannello Ksenia reale e nessun controller Matter reale: il comportamento del firmware è dedotto dal codice e dalle fixture.
- Nessun test con la Homebridge UI reale. Il finding su `customNames` si basa sulla stessa evidenza di produzione documentata dall'autore nel commit `77da740`.
- Le specifiche CSA in PDF non sono state scaricate (richiedono registrazione). I limiti Matter provengono dal modello matter.js 0.17.9 e dagli XML di `project-chip/connectedhomeip`.
- Il comportamento verificato è quello di Homebridge **2.4.0**. Versioni beta precedenti potrebbero differire: dove rilevante il finding lo segnala.

---

# Verification

| Check | Result | Notes |
|---|---|---|
| `npm ci` | PASS | 0 vulnerabilità (`npm audit`, anche `--omit=dev`) |
| `npm run check:max-lines` | PASS | tutti i file ≤ 350 righe. `matter-accessory-registry.ts` è a 348, al limite |
| `npm run build` | PASS | `tsc` |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` | PASS | stesso comando della CI |
| `npm test` (Node 22.22.2) | PASS | baseline 274/274, dopo le fix 287/287 (13 nuovi test) |
| Test su Node 20.20.2 (matrice CI) | PASS | 287/287 contro `dist/` ricompilato |
| Test su Node 24 | NOT RUN | Node 24 non disponibile nel container. La release CI pubblica con Node 24, ma la matrice CI non lo testa (vedi F30) |
| Riproduzioni ad hoc | ESEGUITE | 7 script in scratchpad (vedi *Commands executed*), tutti contro `dist/` ricompilato |
| CI inspection | DONE | `ci.yml` (Node 20/22, max-lines, tsc strict, test, build); `release-publish.yml` (Node 24, provenance, tag/version check); `dependabot-auto-merge.yml` (auto-merge patch/minor) |
| Documentation inspection | DONE | README EN/IT, `docs/en` ↔ `docs/it`, CHANGELOG, ARCHITECTURE, SECURITY |
| Standards reviewed | DONE | Homebridge 2.4.0 (typings e runtime); developers.homebridge.io Matter API; Verified-Plugins (rev. 2026-05-05); HAP-NodeJS 2.2.2; matter.js 0.17.9 (Matter spec 1.6); connectedhomeip ZCL XML; OASIS MQTT 3.1.1/5.0; mqtt.js 5.16.0 |

> ⚠️ **Effetto collaterale da segnalare.** `npm test` inizializza Sentry con il DSN di produzione e invia eventi sintetici ("test error", "test message"; vedi F28). Anche le esecuzioni dei test fatte durante questo audit possono aver inviato quegli eventi al progetto Sentry, se la rete del container li ha lasciati passare.

---

# Field verification

Eseguita il 2026-09-26 su un'installazione reale, dopo il report statico. Nessun inserimento o disinserimento, nessun bypass, nessun comando a luci, tapparelle, cancelli o termostati da parte dell'auditor (i comandi `CMD_SET_OUTPUT`/`CMD_EXE_SCENARIO` visti nella capture alle 20:42 venivano dai controller di casa). PIN, IP del pannello e credenziali non compaiono in questo report.

**Ambiente**

| Voce | Valore |
|---|---|
| Host | Debian 13 (kernel 6.12), Docker, `homebridge/homebridge:latest` (tag 2026-09-25), rete host |
| Homebridge | 2.4.0 (HAP-NodeJS 2.2.2, matter.js 0.17.9), identico al codice analizzato: F01 (`requiresExternalBridge(accessory.deviceType)`), register bridged fire-and-forget, `already registered` su UUID duplicato |
| Node (container) | 24.21.0 |
| Plugin installato | 2.2.0-rc.3 da npm, poi le build del branch installate sostituendo `dist/` nella stessa cartella (dipendenze identiche) |
| Child bridge | sì, `0E:91:2B:75:74:97`, **solo Matter** (`hap.enabled: false`, Matter su 5530), 109 endpoint |
| MQTT | disabilitato nel plugin (non attivato per il test, per scelta dell'utente) |
| Pannello | Lares4, firmware non esposto nei messaggi catturati; `PRG_THERMOSTATS` → `CMD_NOT_AVAILABLE` (percorso degradato "DOMUS sensor id come cfg id" attivo: `thermostat_18` e `thermostat_34` → cfg 1) |
| Backup | `/root/smarthome/_backups/klares4-audit-20260926-202851/` sull'host (config, persist, accessories, storage Matter, file `klares4-*`, plugin rc.3 per il rollback) |

**Gate locali**

| Check | Risultato |
|---|---|
| `npm ci`, `check:max-lines`, `tsc --noEmit --noUnusedLocals --noUnusedParameters` | PASS |
| Test baseline (287) su Node 20.20.2 / 22.23.3 / 24.21.0 / 26.8.1 | PASS su tutte |
| Test finali | 316/316 su Node 26; Sentry bloccato durante ogni esecuzione (5 tentativi di invio per esecuzione, F28) |
| Nuovi test contro la `dist` non modificata del branch | falliscono tutti prima delle fix (F03, F04, F05, F14, F37 e i test di schema F02/F38) |

**Metodo**

- Log NORMAL e DEBUG: `logLevel: 2` e `_bridge.debugModeEnabled: true` (debug di Homebridge solo per il child bridge), `telemetry: false` per tutta la durata.
- Reconnect (F03): regola iptables sull'host che scarta il traffico verso la porta 443 del pannello per 110 s, rimossa da un timer systemd (più un failsafe). Il pannello chiude il socket (1006) dopo circa 16 s; il primo tentativo di riconnessione resta appeso 133 s fino all'ETIMEDOUT del kernel (F39).
- Debug capture: `generateDebugFile: true`, 900 s, 137 messaggi raw, analizzati sull'host senza estrarre dati sensibili.
- F02/F38: `customNames` di prova in `config.json`, salvataggio dalla UI fatto dall'utente, diff; config originale ripristinato subito dopo (hash identico al backup).

**Risultati**

| Finding | Esito sul campo |
|---|---|
| F01 | FIXED: unregister emesso e osservato, nessun `threw … deviceType`; rivelato F37 |
| F02 | CONFIRMED (customNames cancellato dal salvataggio UI) → FIXED |
| F03 | CONFIRMED al boot e al reconnect → FIXED e verificato (nessun placeholder verso Matter) |
| F04 | NOT REPRODUCIBLE (nessun dimmer sul pannello) → FIXED con test |
| F05 | non esercitato (recovery non eseguita) → FIXED con test |
| F06 | condizioni CONFIRMED (cfg 1 in SUM) → FIXED con test; setpoint dal vivo non eseguito |
| F14 | percorso esercitato: il retry con purge ha recuperato il rename rifiutato → FIXED |
| F16 | presupposto CONFIRMED (READ con `RESULT: FAIL`); non impatta questa installazione (HAP disabilitato) |
| F17 | osservato: riscrittura di `config.json` con formattazione diversa |
| F20, F21 | NEEDS VERIFICATION (nessun comando al termostato) |
| F22 | NOT REPRODUCED (PIN stringa, mascherato) → FIXED con test |
| F37 (nuovo) | CONFIRMED sul campo → FIXED e verificato (rename in 1 s, zero `already registered`) |
| F38 (nuovo) | CONFIRMED sul campo → FIXED; round-trip UI del nuovo schema: vedi F38 |
| Avvio con la build | nessun warning o errore del plugin; riepilogo `cycle #1` identico a quello della rc.3 |

---

# Standards compliance

## Homebridge

**Compliant**

- Dynamic platform con `configureAccessory` e `configureMatterAccessory`.
- Registrazione in `didFinishLaunching`.
- Cleanup su `shutdown` (WS, MQTT, telemetry).
- `config.schema.json` con `pluginAlias`, `singular: true` e `required: ["ip","pin"]` in forma draft-6.
- Errori dei setter propagati come `HapStatusError`.
- File scritti dentro `api.user.storagePath()`.
- Il plugin non si avvia senza IP/PIN.

**Deviations**

- REQUIREMENT, schema: `patternProperties`/chiavi utente "non supportate, usare array di oggetti" (developers.homebridge.io, *config-screen/schema*). `customNames.*` viola la regola (F02).
- REQUIREMENT, Verified Plugins: "No analytics or tracking". La telemetry Sentry attiva di default è in tensione con il programma Verified (F29). È un requisito del programma, non dell'API.
- REQUIREMENT, Verified Plugins: "Must run on Node v22 and v24". Node 24 non è testato in CI (F30).
- REQUIREMENT, Verified Plugins: "must not throw unhandled exceptions". Esiste un percorso di unhandled rejection (F23), che Homebridge trasforma in SIGTERM (`homebridge/dist/cli.js:82-90`).

**Uncertain**

- Comportamento della UI con chiavi non dichiarate dentro oggetti dichiarati. Esempio: `domusThermostat.manualCommandPairs` scritto dall'import KSA ma assente dallo schema. NEEDS VERIFICATION.

**Sources**

- https://developers.homebridge.io/#/config-screen/schema
- https://github.com/homebridge/plugins/wiki/Verified-Plugins
- https://developers.homebridge.io/#/api/platform-plugins
- `node_modules/homebridge/dist/cli.js`

## HomeKit / HAP

**Compliant**

- Service/Characteristic corretti per luci, tapparelle, termostato, sensori e zone. Permessi e range clampati (CurrentTemperature -270..100, AmbientLightLevel ≥ 0.0001).
- `updateCharacteristic` per gli aggiornamenti da pannello.
- `HAPStatus.SERVICE_COMMUNICATION_FAILURE` (-70402) sui fallimenti.
- UUID generati da `device.id`, stabili.
- Nomi sanitizzati secondo la regola `checkName`.

**Deviations**

- Stato impossibile dopo un comando fallito (tapparella "in apertura" indefinitamente). Corretto: F11.
- Successo riportato senza comando (termostato senza client). Corretto: F12.
- Brightness senza handler su prima installazione. Corretto: F13.
- Valori default pubblicati come stato reale a ogni reconnect (F03).
- `StatusTampered` usato per rappresentare il bypass (F27). È BEST PRACTICE, non una violazione di specifica.

**Uncertain**

- `TargetTemperature` dal pannello (5..40 °C) oltre i props configurati (default 10..38). HAP-NodeJS clampa con warning (`Characteristic.js` `validateUserInput`), quindi non è un errore ma genera warning in log.

**Sources**

- `node_modules/@homebridge/hap-nodejs/dist/lib/definitions/CharacteristicDefinitions.js`
- `node_modules/@homebridge/hap-nodejs/dist/lib/Characteristic.js` (`validateUserInput` :2041+, handler errors :1711-1723)

## Matter

API consultata: Homebridge **2.4.0**, `api.matter`.

- `registerPlatformAccessories` per accessori bridged è *fire-and-forget*: emette un evento e risolve subito (`MatterAPIImpl.js:242-261`). Gli errori sono solo loggati.
- `unregisterPlatformAccessories` valuta `requiresExternalBridge(accessory.deviceType)` → `deviceType.deviceType` (`MatterAPIImpl.js:37-39, 305-330`).
- Un UUID duplicato nella stessa sessione lancia `already registered`, salvo accessorio restaurato da cache con la stessa forma (`server/AccessoryManager.js:41-95`).
- `getAccessoryState` restituisce `undefined` sia se l'accessorio non esiste sia se il cluster manca (`server/StateManager.js:169-200`).

Modello Matter: matter.js 0.17.9, spec 1.6.

**Compliant**

- NodeLabel ≤ 32 (`basic-information.element.js`, `constraint: "max 32"`). Il sanitizer conta code point e matter.js conta unità UTF-16: equivalenti per il charset ammesso.
- WindowCovering invertito correttamente: 0 = aperto, 10000 = chiuso.
- ContactSensor `stateValue = true` ⇔ contatto chiuso.
- `OnOffOutlet` per gli scenari (dispositivo server controllabile).
- Livelli LevelControl in 1..254.
- Verità di pubblicazione modellata come `requested → published-unverified → locally-published`, coerente con la natura fire-and-forget del register.

**Deviations**

- Unregister con stub `{UUID}`: TypeError deterministico, nessuna rimozione. Corretto: F01.
- Device type deciso prima di conoscere la capability: dimmer → `OnOffLight` (F04).
- Re-register dello stesso UUID senza unregister nei percorsi di recovery (F14).
- Handler termostato che assorbono gli errori senza ripristinare l'attributo. Viola la raccomandazione "throw from handlers so a failure is reported" (developers.homebridge.io, *matter-errors*). È una scelta intenzionale già nota dal piano dell'11/09 (F15).

**Uncertain**

- Limite 32 in byte (octets) o in caratteri a livello di spec CSA: matter.js valida `value.length`. Non verificato sul PDF CSA.
- Comportamento dei controller (Apple/Alexa/Google) dopo rename/re-register: non osservabile dal plugin. Il codice lo dichiara correttamente.

**Sources**

- https://developers.homebridge.io/#/api/matter
- https://developers.homebridge.io/#/api/matter-platform-methods
- https://developers.homebridge.io/#/api/matter-errors
- https://github.com/project-chip/connectedhomeip/blob/master/src/app/zap-templates/zcl/data-model/chip/bridged-device-basic-information-cluster.xml
- file `node_modules/homebridge/dist/matter/**` citati sopra

## MQTT

**Compliant**

- Topic di stato senza wildcard.
- Comandi su `…/set` separati dai topic di stato retained, quindi nessun feedback loop.
- Payload JSON validati con type guard e range.
- Subscribe ripetuto su `connect` (clean session).

**Deviations**

- Parsing dei comandi legato a un prefisso di 2 livelli. Corretto: F07.
- Messaggi di comando con flag `retain` rieseguiti a ogni (ri)connessione (F25). MQTT-3.3.1-6: i retained vengono consegnati ai nuovi subscriber.
- Coda offline illimitata in memoria (F26).
- Room name non validato per `+`, `#`, `/` nei topic di publish. MQTT-3.3.2-2: i topic di publish non devono contenere wildcard. Impatto: errore di publish loggato; incluso in F25 come nota.

**Uncertain**

- Stabilità degli slug: dipendono dal nome visibile, per design. Un rename sul pannello cambia il topic. Documentato come comportamento; nessuna migrazione.

**Sources**

- https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html
- https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html
- `node_modules/mqtt/build/lib/client.js:1122-1181`

---

# Findings

Ordine: severità, poi impatto. "FIXED" indica una patch applicata in questo audit con test di regressione. Nessun commit è stato fatto.

## [P1] F01 — Unregister Matter sempre inefficace su Homebridge 2.4 (rename, prune, recovery no-op) — FIXED (verificato sul campo)

**Stato sul campo:** FIXED. Con la build del branch l'unregister viene emesso (`Unregistering 1 Matter accessory`) e l'endpoint rimosso (`Unregistered Matter accessory: PC (light_37)`), senza nessun `threw … deviceType`. Il rename ha però rivelato F37, corretto a parte.

**Category:** API CONTRACT VIOLATION
**Files:** `src/platform/matter-topology-coordinator.ts`, `src/platform/matter-accessory-registry.ts`
**Lines:** coordinator `unregister()` (prima della fix: `[{ UUID: uuid } as MatterAccessory]`)
**Evidence:** `homebridge/dist/matter/MatterAPIImpl.js:37-39` definisce `requiresExternalBridge(deviceType) => … externalType.deviceType === deviceType.deviceType`. `:305-330` chiama `unregisterPlatformAccessories`, che valuta `requiresExternalBridge(accessory.deviceType)` **prima** di emettere l'evento di rimozione. Con lo stub `{UUID}` si ottiene `TypeError: Cannot read properties of undefined (reading 'deviceType')` e nessun evento viene emesso. Il coordinator cattura l'errore e lo logga solo a livello `debug`, poi attende l'assenza fino al timeout (3 s) e restituisce `false`.
**Scenario:** la riproduzione è `repro-unregister.js` (mock con la semantica di HB 2.4). Una recovery termostato con `matterRecoveryRequests` produce: `unregister call … threw … (reading 'deviceType')`, poi `was not locally observable before timeout`, poi store `reason: recovery-unregister-timeout`. L'endpoint resta `TemperatureSensor`.
**Expected:** l'endpoint viene rimosso e il rename, il prune o la recovery proseguono.
**Actual:** l'endpoint non viene mai rimosso. Conseguenze:
- ogni rename del name-map viene saltato ("endpoint still present");
- ogni prune degli endpoint stale fallisce a ogni avvio (3 s ciascuno);
- la recovery esplicita del termostato non riesce mai;
- il purge degli endpoint stale non ha effetto.
**Impact:** le funzionalità principali di 2.2.0-rc.x (naming, prune, recovery) sono inoperanti su HB 2.4.0, e la causa è invisibile a log level normale.
**Why this matters:** CHANGELOG rc.2 dichiara "Matter renames work again" e rc.3 attribuisce il problema alle "betas". Nella versione installata la causa è invece deterministica. Due test esistenti passano per ragioni sbagliate:
- `matter-topology-coordinator.test.js` "unregister trusts observation over a throwing API call": il mock cancella l'endpoint *e poi* lancia l'eccezione, cosa che HB 2.4 non fa;
- il mock di `matter-accessory-registry.test.js` accetta qualunque stub.
**Relevant standard/API:** `MatterAPI.unregisterPlatformAccessories(pluginIdentifier, platformName, accessories: MatterAccessory[])` (`homebridge/dist/api.d.ts:327`). La doc dice "only uuid is required", ma il runtime 2.4.0 la contraddice. È un difetto upstream da segnalare, ma il plugin deve conformarsi al runtime.
**Existing test coverage:** nessuna con la semantica reale.
**Suggested fix (applicata):**
- il coordinator ricorda l'ultimo `MatterAccessory` passato a `register()`;
- il registry chiama `topologyCoordinator.remember(accessory)` in `configureCachedAccessory`;
- `unregister()` passa quell'oggetto e usa lo stub solo come ultima risorsa;
- la mappa viene ripulita dopo un'assenza osservata.

Tutti i manager Matter di Homebridge (main e child bridge) ricevono l'oggetto per riferimento nello stesso processo, quindi non c'è serializzazione IPC di funzioni.
**Regression test:**
- `test/matter-topology-coordinator.test.js`: "unregister hands Homebridge the registered accessory…" e "…endpoint only known from the Homebridge cache";
- `test/matter-accessory-registry.test.js`: "explicit thermostat recovery removes a cache-restored fallback endpoint under Homebridge 2.4 unregister semantics". Il mock ora supporta `initiallyQueryable` per modellare gli endpoint restaurati da cache.
**Confidence:** High per HB 2.4.0. Per beta precedenti: NEEDS VERIFICATION.

## [P1] F02 — `customNames` viene cancellato dalla Homebridge UI al primo salvataggio — CONFIRMED sul campo, FIXED

**Stato sul campo:** CONFIRMED. `customNames.outputs = {"37": "PC Test Audit"}` aggiunto a `config.json`, poi un salvataggio dalla UI (Plugin → Klares4 → Salva): nel diff `customNames` è sparito. Lo stesso salvataggio ha prodotto F38. **Fix:** forma array `[{ deviceId, name }]` in schema e layout, normalizzatore `platform/custom-names-config.ts` che accetta anche la mappa legacy, import KSA che scrive la forma array, test di schema anti-mappa. Round-trip UI del nuovo schema: vedi *Field verification*.

**Category:** COMPATIBILITY / BEST PRACTICE (requisito dello schema UI)
**Files:** `config.schema.json`, `src/platform/discovery-service.ts`, `src/platform/ksa-import-service.ts`
**Lines:** schema `customNames` (≈291-320: `type: object` con `additionalProperties: {type: string}` per `zones/outputs/sensors/scenarios`); layout ≈1016-1060 (`type: "object"`); `discovery-service.ts:373-398`; `ksa-import-service.ts:193-201, 222-229`
**Evidence:** la forma è identica a quella di `matterOverrides` prima di `77da740`: oggetto indicizzato per ID con `additionalProperties`, reso nel layout come `type: "object"`. Il messaggio del commit `77da740` documenta un incidente reale: "The Homebridge UI rebuilds config.json from its form model and silently drops object-typed keys whose properties it cannot render… a production install lost 18 live overrides by turning off debug logging". La doc ufficiale dello schema indica che le chiavi definite dall'utente non sono supportate e vanno usati array di oggetti.
**Scenario:**
1. L'utente configura `customNames.outputs = {"18": "Riscaldamento Soggiorno"}`, a mano oppure con l'import KSA `applyCustomNames`.
2. Dalla UI disattiva il debug e salva.
3. `customNames.*` scompare da `config.json`.
4. Al riavvio i nomi tornano quelli del pannello su HomeKit, MQTT (lo slug cambia, quindi cambiano i topic) e Matter (cambia la base del name-map, quindi rename).
**Expected:** i nomi personalizzati sopravvivono ai salvataggi della UI.
**Actual:** vengono persi silenziosamente, con effetto a cascata sui topic MQTT e sui nomi Matter e vocali.
**Impact:** stato persistente errato e rottura di automazioni MQTT basate sui topic.
**Why this matters:** è l'invariante esplicito "le impostazioni per-device non devono essere map indicizzate dinamicamente" ed è già stato violato una volta in produzione.
**Relevant standard/API:** https://developers.homebridge.io/#/config-screen/schema ("patternProperties … not supported; use arrays of objects") — REQUIREMENT per la UI.
**Existing test coverage:** nessuna.
**Suggested fix:** replicare `matter-override-config.ts`:
- nuovo formato array `customNames: [{ deviceId: "light_18", name: "…" }]`, oppure array per categoria `{ id, name }`;
- accettare e normalizzare anche il formato map esistente (backward-compatible, nessun BREAKING CHANGE);
- aggiornare l'import KSA perché scriva il nuovo formato.

Documenti da aggiornare: README (EN e IT, tabelle config), `docs/en/config-and-ui.md`, `docs/it/configurazione-e-ui.md`, CHANGELOG `[Unreleased]`.
**Regression test:** test di normalizzazione su entrambe le forme (come `test/matter-override-config.test.js`), più un test di schema che fallisce se una proprietà per-device usa `additionalProperties`.
**Confidence:** High (stesso meccanismo già osservato in produzione dall'autore). La UI non è stata testata direttamente.

## [P1] F03 — Ogni (ri)connessione pubblica i default del parser come stato reale (transizioni spurie HomeKit/Matter) — CONFIRMED sul campo, FIXED (verificato)

**Stato sul campo:** CONFIRMED, al boot e al reconnect (blocco iptables di circa 110 s verso il pannello). Log DEBUG di Homebridge, update di attributi Matter: la tapparella "Finestra Bagno Matrimoniale" (reale 80% aperta) passa da `currentPositionLiftPercent100ths: 10000` (chiusa) a 2000; il contatto "Contatto Bagno Matrimoniale" (finestra aperta) passa da `stateValue: true` (chiusa) di nuovo ad aperta circa 1 s dopo; i sensori DOMUS vanno a `measuredValue: 0` (0 °C) e i termostati a 2000 (20 °C) prima dei valori reali (2430). **Fix:** `device-observation.ts` (placeholder di discovery marcati, merge con lo stato noto) e `websocket-client/discovered-device.ts`; alla rediscovery il device conserva lo stato osservato; al boot Matter/HAP usano lo stato in cache finché il pannello non ne riporta uno. **Dopo la fix, sul campo:** 0 push di 0 °C/20 °C, tapparella solo 2000, contatto aperto sempre `false`, al boot e al reconnect. MQTT non verificato sul campo (disabilitato su questa installazione): pubblica solo sugli update di stato, quindi non riceveva placeholder dalla discovery.

**Category:** ROBUSTNESS
**Files:** `src/websocket-client/message-service.ts`, `src/websocket/device-state-projector.ts`, `src/websocket-client/device-parsers.ts`, `src/platform/index.ts`, `src/platform/accessory-registry.ts`
**Lines:** `message-service.ts:94-98` (zone), `:118-122` (output), `:150-178` (sensori DOMUS); `device-state-projector.ts:100-146` (default `on:false`, `position:0`, termostato `mode:'off'` e 20/21 °C); `platform/index.ts:256-273`; `accessory-registry.ts:57-75`
**Evidence:** `requestSystemData()` rilegge tutto a ogni login. Ogni `READ_RES` di discovery crea un **nuovo** oggetto device con i default, lo sostituisce in `state.devices` ed emette `onDeviceDiscovered`. La piattaforma chiama `addAccessory` → `updateAccessoryHandler` → `updateStatus(default)` e `matterRegistry.addOrUpdateAccessory` → `enqueueStateFor` + flush. Solo dopo arrivano `STATUS_OUTPUTS`/`STATUS_BUS_HA_SENSORS` con lo stato reale.
**Scenario (riprodotto, `repro-pipeline.js`):**
- Primo sync: `light_5 on:true 60%`, `cover_7 80%`, `sensor_temp_1 21.5 °C`.
- Secondo sync (reconnect), emissioni in ordine: `discovered light_5 {"on":false}`, `discovered cover_7 {"position":0}`, `discovered sensor_temp_1 {"value":0}`, `sensor_hum_1 50%`, `sensor_light_1 100 lux`. Solo dopo `update light_5 on:true`, `update cover_7 80`, `update … 21.5`.
- Per i termostati il default è `mode: 'off'`. Per le zone lo stato iniziale arriva solo dal `REALTIME_RES`.
**Expected:** una ri-lettura di configurazione non altera lo stato osservato già noto.
**Actual:**
- a ogni reconnect (heartbeat timeout, reboot del pannello, Wi-Fi) HomeKit e Matter ricevono eventi "luce spenta", "tapparella chiusa", "0 °C", "termostato OFF", poi il ritorno allo stato reale;
- anche al boot i valori dalla cache vengono sovrascritti con i default prima dello stato reale;
- `setBrightness` durante la finestra restituisce successo senza inviare nulla, perché `dimmable` è tornato `false`.
**Impact:** automazioni HomeKit/Matter con trigger su soglie ("temperatura esterna < 3 °C") o su cambi di stato possono scattare; notifiche spurie per i contatti.
**Why this matters:** "stato HomeKit/Matter sbagliato" su un percorso che si ripete periodicamente in uso reale.
**Relevant standard/API:** HAP event notifications (`updateCharacteristic` notifica i controller); Matter attribute reporting.
**Existing test coverage:** nessuna (i test di pipeline coprono un solo sync).
**Suggested fix:**
- in `MessageService`, quando un device con lo stesso `id` e `type` è già in `state.devices`, aggiornare solo nome e descrizione e **mantenere** `status` (e i campi top-level del termostato);
- in alternativa, non emettere `onDeviceDiscovered` per device già noti con lo stesso tipo.

Test: due sync consecutivi non devono emettere stati diversi dall'ultimo reale. Da fare prima di dichiarare stable.
**Regression test:** `repro-pipeline.js` trasformato in test: dopo il secondo `MULTI_TYPES` nessuna emissione con `on:false`/`value:0`.
**Confidence:** High sul meccanismo. L'impatto sulle automazioni dipende dalla configurazione dell'utente.

## [P1] F04 — I dimmer vengono registrati su Matter come `OnOffLight` (dimmerazione Matter mai disponibile) — NOT REPRODUCIBLE sul campo, FIXED

**Stato sul campo:** NOT REPRODUCIBLE: il pannello non ha uscite dimmerabili (tutte le luci `dimmable:false`, nessun `POS` negli `STATUS_OUTPUTS`). Il difetto resta confermato dal codice e dai test con il mock HB 2.4. **Fix:** `platform/matter-light-capability.ts`: al primo stato con livello, unregister osservato e poi register come `DimmableLight` sotto lo stesso UUID, serializzati dal gate F05; ai boot successivi la capability viene letta dal `context` della cache Matter.

**Category:** ROBUSTNESS / SPEC (device type errato)
**Files:** `src/platform/matter-device-mapper.ts`, `src/platform/matter-accessory-registry.ts`, `src/websocket/device-state-projector.ts`
**Lines:** `matter-device-mapper.ts:126-160` (`isDimmable` deciso al mapping), `:116-122` (`hasAccessoryMetadataChanged` ignora `deviceType`/cluster); `device-state-projector.ts:109` (`dimmable: false` sempre in discovery); `status-updater.ts:52-57` (`dimmable = true` solo con `POS`)
**Evidence:** la registrazione Matter parte da `handleDeviceDiscovered`, cioè prima di qualunque `STATUS_OUTPUTS`, quindi `isDimmable` è sempre `false`. `refreshAccessoryMetadata` rimappa ma non rileva il cambio di device type.
**Scenario (riprodotto, `repro-matter-dimmer.js` con mock HB 2.4):** endpoint `{ type: 'OnOffLight', clusters: {onOff} }`. Aggiornamenti inviati: `onOff…`, poi `levelControl:{"currentLevel":152}` verso un endpoint **senza** cluster levelControl (errore loggato da Homebridge).
**Expected:** i dimmer sono esposti come `DimmableLight` con `levelControl`.
**Actual:** i dimmer sono sempre on/off su Matter, a ogni avvio (la discovery precede sempre lo stato), e generano un errore di state update a ogni variazione di luminosità.
**Impact:** funzione di controllo mancante su Matter (Alexa/Google/Apple via Matter).
**Why this matters:** divergenza tra HAP (che dopo il primo restart funziona, grazie al context in cache) e Matter.
**Relevant standard/API:** Matter Device Library: DimmableLight (0x0101) richiede LevelControl; OnOffLight (0x0100) no.
**Existing test coverage:** nessuna; tutti i test usano `dimmable: false`.
**Suggested fix:**
- rinviare la registrazione Matter delle luci fino al primo stato output (oppure al `handleInitialSyncComplete`);
- oppure persistere la capability `dimmable` per `device.id` (ad esempio nel context/cache Matter) e usarla al mapping;
- in ogni caso includere `deviceType` in `hasAccessoryMetadataChanged` e gestire il cambio con unregister+register. Ora funziona grazie alla fix F01, e HB 2.4 ri-registra automaticamente gli accessori da cache "changed structure".
**Regression test:** registry: discovery `dimmable:false`, poi status con `POS`; atteso `DimmableLight` registrato.
**Confidence:** High.

## [P1] F05 — Race nella recovery esplicita del termostato: doppia registrazione dello stesso UUID — FIXED (non esercitato sul campo)

**Stato sul campo:** non esercitato: nessuna `matterRecoveryRequests` è stata eseguita, perché avrebbe cambiato il device type dei 6 termostati nei controller. Il codice Homebridge installato (2.4.0) conferma il presupposto (UUID duplicato → `already registered`, solo loggato). **Fix:** `platform/matter-registration-gate.ts`, una registrazione in volo per `device.id`; i chiamanti concorrenti la attendono e poi seguono il normale percorso di update. Test con un mock fedele a HB 2.4 (`test/fixtures/hb24-matter-api.js`).

**Category:** ROBUSTNESS (concurrency)
**Files:** `src/platform/matter-accessory-registry.ts`, `src/platform/matter-thermostat-recovery-request.ts`
**Lines:** `matter-accessory-registry.ts:91-131` (check `registrations.get` → `registerAccessory`), `:188-213` (`await resolvePersistedThermostatFallback` **prima** di `registrations.set`)
**Evidence:** con una `matterRecoveryRequests` attiva, `resolvePersistedThermostatFallback` attende `topologyCoordinator.unregister(...)` (fino a 3 s più la coda). Nel frattempo `updateAccessoryState` per lo stesso termostato, innescato da `CFG_THERMOSTATS`/`STATUS_*` pochi ms dopo la discovery, non trova registrazioni e chiama di nuovo `registerAccessory`.
**Scenario (timeline riprodotta, `repro-race-hb24.js`, mock fedele a HB 2.4 dopo la fix F01):**
- T0: `READ_RES MULTI_TYPES` → `addOrUpdateAccessory(thermostat_18)` → `beginRecovery` (record `retrying`) → `await unregister`.
- T0+50 ms: `updateAccessoryState(thermostat_18)` → nessuna registrazione → `registerAccessory`. `beginRecovery` restituisce `false` (record `retrying`), quindi mappa come **TemperatureSensor** e mette il register in coda.
- T0+300 ms: l'endpoint vecchio sparisce; la prima chiamata registra il **Thermostat** nativo.
- T1: HB registra prima il TemperatureSensor; il Thermostat viene rifiutato con `already registered` (solo log di HB). Il plugin sonda il nativo, non è interrogabile, fallback, secondo `already registered`.
- Esito finale: endpoint `TemperatureSensor`, store `fallback`, richiesta di recovery **consumata** (`lastProcessedRecoveryRequest=1`).
- Controllo senza update concorrente (`repro-norace-hb24.js`): endpoint `Thermostat`, store `native`.
**Expected:** una sola registrazione in volo per `device.id`; gli update concorrenti vengono accodati.
**Actual:** doppia registrazione e recovery fallita silenziosamente. Prima della fix F01 la recovery falliva comunque; ora questo è l'ultimo ostacolo.
**Impact:** il termostato resta non controllabile via Matter; l'utente deve incrementare `generation` e riprovare, con la stessa race.
**Why this matters:** caso "due discovery contemporanee / register concorrenti" richiesto dall'audit, dimostrato.
**Relevant standard/API:** `server/AccessoryManager.js:88-94` (duplicate UUID → throw, solo loggato dal manager).
**Existing test coverage:** i test di recovery fanno `await addOrUpdateAccessory` isolato, quindi non c'è interleaving.
**Suggested fix:** mappa `inFlightRegistrations: Map<id, Promise<void>>`. `addOrUpdateAccessory`/`updateAccessoryState` riusano la promessa in volo e, alla sua risoluzione, fanno `enqueueStateFor` + `scheduleFlush`. Usarla anche in `finalizer.registerRenamed`. Il file è a 348/350 righe: estrarre un piccolo helper (ad esempio `matter-registration-gate.ts`). Per le registrazioni non-recovery la finestra si chiude nello stesso drain di microtask, quindi il rischio è confinato alla recovery.
**Regression test:** `repro-race-hb24.js` come test: atteso `Thermostat` nativo e un solo register effettivo.
**Confidence:** High.

## [P1] F06 — Scrittura del setpoint con la stagione sbagliata: modifica persa in estate, oppure il pannello passa a raffrescamento — CONFIRMED (condizioni presenti sul campo), FIXED

**Stato sul campo:** condizioni CONFIRMED: dalla debug capture, la cfg termostato id 1 (Sala, `thermostat_18`/`thermostat_34`) è in `ACT_SEA: SUM`, le cfg 2-5 in `WIN`. Il realtime `STATUS_TEMPERATURES.THERM.ACT_SEA` coincide con la cfg (nessun cambio di stagione in 15 minuti), quindi dopo un riavvio un setpoint su "Sala" avrebbe riscritto `SUM.TM` invariato. Il cambio di setpoint dal vivo non è stato eseguito per scelta dell'utente: con ACT_MODE forzato a MAN avrebbe acceso l'impianto. **Fix:** `ThermostatSeasonTracker`: la stagione è la più recente tra l'ultimo `WRITE_CFG` con ACK positivo e il realtime `ACT_SEA`, altrimenti la cfg in cache; la patch viene costruita per quella stagione; nessun hint prima dell'ACK.

**Category:** ROBUSTNESS (controllo errato)
**Files:** `src/websocket-client/thermostat-command-payload.ts`, `src/websocket-client/thermostat-write-payload.ts`, `src/websocket-client/command-service.ts`
**Lines:** `thermostat-write-payload.ts:34-47` (patch costruita per `seasonById.get(id) ?? 'WIN'`); `thermostat-command-payload.ts:56-68` (stagione attiva = hint ?? `cfg.ACT_SEA`, ma patch presa da `setpointPatch[activeSeason]`); `command-service.ts:157` (hint impostato **prima** dell'ACK, mai annullato)
**Evidence (eseguito contro `dist/`):**
- (a) Nessun hint (sempre dopo un riavvio: la mappa è in memoria) e cfg con `ACT_SEA:'SUM'`, `SUM.TM:'26.0'`. Impostare 23 °C produce `{"ACT_SEA":"SUM","SUM":{"TM":"26.0"}}`: il setpoint **non cambia**, l'ACK è positivo, HomeKit/Matter ricevono un successo.
- (b) Hint `SUM` rimasto da un `setThermostatMode('cool')` fallito o superato, con il pannello in `WIN`. Impostare 21 °C produce `{"ACT_SEA":"SUM","SUM":{"TM":"21.0"}}`: **la centrale passa alla stagione estiva** come effetto collaterale.
**Scenario:**
- Estate, pompa di calore in raffrescamento, Homebridge riavviato. Ogni modifica di temperatura da HomeKit/Matter/MQTT viene scartata; il valore torna indietro al primo realtime.
- Inverno: la stagione è stata cambiata dal tastierino o dall'app Ksenia dopo un comando "cool" da HomeKit. Il primo setpoint da HomeKit rimette la centrale in modalità estiva.
**Expected:** la patch riguarda la stagione **effettivamente attiva** sul pannello; l'hint serve solo se lo stato del pannello è sconosciuto.
**Actual:** hint e cfg vengono combinati in modo incoerente.
**Impact:** controllo errato dell'impianto (raffrescamento invece di riscaldamento) o comando silenziosamente inefficace, con successo riportato.
**Why this matters:** viola l'invariante write ≠ success (successo con payload che non applica il comando) e produce effetti fisici.
**Relevant standard/API:** protocollo Ksenia `WRITE_CFG CFG_THERMOSTATS` (`docs/*/termostati-domus.md`).
**Existing test coverage:** nessun test per SUM senza hint, né per hint stale. `websocket-thermostat-realtime.test.js:340-390` mostra che il realtime `STATUS_TEMPERATURES.THERM.ACT_SEA` può essere più fresco della cfg in cache.
**Suggested fix:** determinare la stagione con priorità: stato realtime osservato (`thermostatRealtimeSnapshotById`/modalità del device: `cool` → SUM, `heat` → WIN) > `cfg.ACT_SEA` > hint > `WIN`. Poi costruire la patch **per quella stagione**. Aggiornare l'hint solo dopo l'ACK positivo. Non implementato qui: sceglie la fonte di verità della stagione e merita una decisione esplicita.
**Regression test:** `buildThermostatSetpointCommandPayload` con (SUM, nessun hint) → `SUM.TM` aggiornato; (hint SUM, realtime WIN) → resta WIN.
**Confidence:** High (riprodotto; verificato indipendentemente in seconda passata).

## [P2] F07 — Comandi MQTT ignorati con `mqtt.topicPrefix` diverso da 2 livelli — FIXED

**Category:** ROBUSTNESS / COMPATIBILITY
**Files:** `src/mqtt/topic-parser.ts`, `src/mqtt-bridge/index.ts`
**Lines:** `parseCommandTopic` (indici fissi `topicParts[2..4]`/`[3..5]`); `handleIncomingMessage`
**Evidence:** la subscribe usa `${prefix}/+/+/set`, ma il parser assume 5 o 6 segmenti totali.
**Scenario:**
- `topicPrefix: "klares4"`: `klares4/light/light_1/set` ha 4 segmenti, viene rifiutato ("Invalid topic format"). Per coincidenza i topic con stanza funzionano.
- `topicPrefix: "casa/allarme/klares4"`: i comandi diretti funzionano per coincidenza, quelli con stanza vengono rifiutati.
**Expected:** funzionamento con qualunque prefisso configurabile (lo schema lo permette).
**Actual:** comandi MQTT silenziosamente persi.
**Impact:** integrazioni MQTT (Home Assistant, Node-RED) non controllano nulla.
**Relevant standard/API:** MQTT topic levels (OASIS 3.1.1 §4.7).
**Existing test coverage:** solo prefisso di default.
**Suggested fix (applicata):** `parseCommandTopic(topic, topicPrefix?)` rimuove il prefisso configurato **così com'è**, cioè lo stesso prefisso raw usato nel filtro di subscribe `${topicPrefix}/+/+/set`: un prefisso `klares4/` produce topic `klares4//…` e resta coerente. Poi analizza i 3 o 4 livelli restanti. Senza prefisso il comportamento è invariato; nessun cambio di topic shape. Una prima versione della fix toglieva lo slash finale e rompeva i comandi con stanza con prefisso `klares4/`: individuato dalla review avversariale e corretto.
**Regression test:** `test/mqtt-topic-parser.test.js` "honours a configured topicPrefix of any depth" e "matches the subscribed filter when the prefix has a trailing slash".
**Confidence:** High.

## [P2] F08 — Con pannello offline all'avvio, MQTT e debug capture non partono mai — FIXED

**Category:** ROBUSTNESS (lifecycle)
**Files:** `src/platform/index.ts`
**Lines:** `initializeLares4()`; prima della fix `await this.wsClient.connect()` precedeva la creazione di `MqttBridge` e `DebugCaptureManager`
**Evidence:** `connect()` rifiuta su errore, login timeout o login fallito. Il `catch` esterno logga "Lares4 initialization error". Il client continua a riconnettersi in background (`close` → `scheduleReconnect`), ma MQTT e debug capture restano disattivati fino al riavvio di Homebridge.
**Scenario:** blackout; Homebridge riparte prima del pannello. Il WS si riconnette dopo 1 minuto, ma MQTT resta morto. `generateDebugFile` non cattura nulla proprio quando serve la diagnosi.
**Expected:** i servizi indipendenti partono comunque.
**Actual:** vengono disattivati in modo permanente per la sessione.
**Impact:** perdita dell'integrazione MQTT fino a un riavvio manuale.
**Existing test coverage:** nessuna.
**Suggested fix (applicata):** creazione di MQTT e debug capture spostata prima di `await connect()`. Effetto collaterale positivo: la capture include anche il LOGIN (il PIN resta mascherato da `captureRawMessage`).
**Regression test:** `test/platform-startup.test.js`.
**Confidence:** High.

## [P2] F09 — Un `close` tardivo del socket sostituito smonta la connessione viva — FIXED

**Category:** ROBUSTNESS (race / reconnect)
**Files:** `src/websocket-client/connection-service.ts`
**Lines:** handler `open`/`message`/`close`/`error`/`pong` in `connect()`; `forceReconnect()`
**Evidence:** gli handler di ogni socket agivano sullo stato condiviso (`state.isConnected`, `state.idLogin`, pending, `onDisconnected`) senza verificare che il socket fosse ancora quello corrente. `forceReconnect` termina il vecchio socket dopo 3 s (`terminateIfNotClosed(ws, 3000)`), mentre il reconnect parte dopo `reconnectInterval` ±10%, con minimo 1000 ms da schema.
**Scenario (timeline, riprodotta con un server `ws` locale):**
- T0: heartbeat timeout → `forceReconnect` (`isManualClose=true`), close graceful del socket 1.
- T0+1 s: nuovo socket 2, login OK (`idLogin=2`, `isConnected=true`).
- T0+3 s: `terminate()` del socket 1 → il suo `close` imposta `isConnected=false`, `idLogin=undefined` e rifiuta i pending. Con `isManualClose` ancora `true` non riprogramma il reconnect.
- Risultato: socket 2 aperto ma plugin "disconnesso"; tutti i comandi falliscono con `Not connected`. L'heartbeat non fa ping perché `isConnected` è `false`, quindi il blocco non viene mai rilevato.
**Expected:** gli eventi di socket obsoleti vengono ignorati.
**Actual:** controllo perso fino alla chiusura del socket da parte del pannello.
**Impact:** dispositivi non controllabili. Richiede `reconnectInterval` < ~3 s; il default 5 s non è colpito.
**Existing test coverage:** nessuna sul lifecycle reale.
**Suggested fix (applicata):**
- ogni handler verifica `state.ws === ws`;
- un socket superato fa solo `rejectOnce` della propria promessa;
- `isManualClose` viene azzerato a ogni nuovo tentativo, altrimenti il flag residuo del socket superato bloccherebbe il reconnect successivo.
**Regression test:** `test/websocket-connection-lifecycle.test.js` (include la verifica che una caduta reale del socket vivo programmi ancora il reconnect).
**Confidence:** High sul meccanismo; Medium sulla frequenza (dipende dalla configurazione).
**Residui preesistenti (non introdotti dalla fix, non corretti):**
- il timer di login timeout usa `this.deps.state.ws` e `state.pendingLogin` condivisi: il timer di un tentativo superato potrebbe chiudere il socket nuovo;
- per il `close` di un socket superato non si esegue più `onDisconnected`, quindi le conferme di stato pendenti di quel socket scadono per timeout (limitato, 8 s) invece di essere rifiutate subito.

## [P2] F10 — Un ACK tardivo viene attribuito a un altro comando pendente — FIXED

**Category:** ROBUSTNESS (correlazione comandi)
**Files:** `src/websocket/command-dispatcher.ts`
**Lines:** `resolvePendingCommand()` (fallback "single-compatible")
**Evidence:** se l'ID della risposta non è pendente, il dispatcher cerca un unico pendente compatibile. Un comando già chiuso da conferma di stato, timeout o `clearPendingCommand` libera il proprio ID.
**Scenario:**
- T0: luce A (ID 111) e tapparella B (ID 222) inviate insieme (scena HomeKit).
- T1: realtime per A → A `state-confirmed`, pendente 111 rimosso.
- T2: arriva `CMD_USR_RES` con `ID=111` → non pendente → unico compatibile B → **B "acknowledged"**.
- Se B viene poi rifiutato (`RESULT=FAIL`, ID 222), la risposta viene ignorata.

Stessa dinamica con un ACK arrivato dopo un timeout.
**Expected:** risposte per ID già ritirati ignorate.
**Actual:** falso successo o falso fallimento su un altro dispositivo. Viola l'invariante "write ≠ success".
**Impact:** esito dei comandi errato; HomeKit mostra un successo non confermato.
**Existing test coverage:** nessuna.
**Suggested fix (applicata):** set limitato (256) di ID ritirati. Una risposta con ID ritirato viene ignorata; un ID riusato viene rimosso dal set alla nuova registrazione. Il fallback per firmware con ID diverso resta invariato per ID mai visti.
**Regression test:** `test/websocket-command-dispatcher.test.js`, due nuovi test.
**Confidence:** High sul meccanismo; frequenza dipendente dal firmware.

## [P2] F11 — Tapparella HomeKit bloccata in "Apertura…/Chiusura…" dopo un comando fallito — FIXED

**Category:** ROBUSTNESS (HAP state)
**Files:** `src/accessories/cover-accessory.ts`
**Lines:** `setTargetPosition()` (`positionState` e `targetPosition` impostati prima del comando e mai ripristinati nel `catch`)
**Scenario:** pannello offline; utente imposta 80% → `moveCover` lancia l'eccezione → HomeKit riceve `-70402`. `PositionState` resta `INCREASING` e `getTargetPosition()` restituisce 80, a tempo indefinito (nessun realtime arriverà).
**Expected:** stato fermo alla posizione reale.
**Actual:** stato impossibile e persistente.
**Existing test coverage:** nessun test sugli accessori HAP (prima di questo audit).
**Suggested fix (applicata):** nel `catch` si ripristinano `targetPosition` e `positionState` **precedenti** al comando fallito e si aggiornano le characteristic. Da fermo, questo significa "fermo alla posizione reale"; se un movimento precedente accettato è ancora in corso, target e direzione di quel movimento restano validi. La prima versione forzava STOPPED anche in questo caso: correzione nata dalla review avversariale.
**Regression test:** `test/hap-accessories.test.js`, due test (fermo e durante un movimento), su classi HAP-NodeJS reali.
**Confidence:** High.

## [P2] F12 — Termostato HomeKit: successo senza invio quando il client WS non esiste — FIXED

**Category:** API CONTRACT VIOLATION (invariante comandi)
**Files:** `src/accessories/thermostat-accessory.ts`
**Lines:** `setTargetHeatingCoolingState`, `setTargetTemperature` (`await this.platform.wsClient?.…`)
**Scenario:** config senza PIN, oppure finestra prima della creazione del client. `configureAccessory` crea comunque l'handler dalla cache; il set restituisce successo e aggiorna lo stato locale, ma **nulla** viene inviato. Luci, tapparelle, cancelli e scenari lanciano correttamente un'eccezione.
**Expected:** `HapStatusError`.
**Actual:** falso successo.
**Suggested fix (applicata):** guard esplicita, come negli altri accessori.
**Regression test:** `test/hap-accessories.test.js`.
**Confidence:** High. Gli handler Matter usano lo stesso `getWsClient()?.`, ma lì il client esiste sempre, perché la registrazione nasce dalla discovery WS: rischio teorico, non corretto.

## [P2] F13 — Dimmer HomeKit non controllabile fino al primo riavvio (prima installazione) — FIXED

**Category:** ROBUSTNESS (HAP handlers)
**Files:** `src/accessories/light-accessory.ts`
**Lines:** costruttore (handler `Brightness` legati solo se `dimmable` è già vero)
**Evidence:** vedi F04: in discovery `dimmable` è sempre `false`. `updateStatus` successivo pubblica `Brightness` con `updateCharacteristic`, e HAP-NodeJS crea la characteristic opzionale **senza handler**. Una scrittura del controller viene memorizzata come valore e restituita come successo senza effetto.
**Scenario:** prima installazione; il dimmer mostra lo slider, lo slider non fa nulla. Dopo il riavvio funziona, perché il context in cache ha `dimmable: true`.
**Suggested fix (applicata):** binding lazy e idempotente degli handler quando `dimmable` diventa vero.
**Regression test:** `test/hap-accessories.test.js`.
**Confidence:** High.

## [P2] F14 — Recovery "not queryable": re-register dello stesso UUID senza unregister — FIXED (verificato sul campo)

**Stato sul campo:** il percorso è stato esercitato: il rename di `light_37` era stato rifiutato ("already registered", vedi F37) e il retry con unregister al primo tentativo l'ha recuperato (`retrying registration (1/2) [stale-endpoint purge]` → `registered`). Nota di precisione: in HB 2.4 un register fallito non lascia l'UUID nella mappa (`AccessoryManager` lo aggiunge solo a fine registrazione), quindi il caso scatta quando un endpoint esiste ma la probe sul cluster atteso fallisce (endpoint dell'altra forma, endpoint in chiusura). **Fix:** `removeBeforeReregister` prima del fallback e di ogni retry.

**Category:** API CONTRACT VIOLATION
**Files:** `src/platform/matter-registration-recovery.ts`, `src/platform/matter-accessory-registry.ts`
**Lines:** `handleMissingRegisteredAccessory()` (`registerFallbackAccessory` e retry `register(reg.matterAccessory)` senza unregister al primo tentativo); `registerFallbackAccessory()` (`register(fallback)`); `handleRegisterFailure()`
**Evidence:** in HB 2.4 un UUID già registrato in sessione lancia `already registered` (`AccessoryManager.js:88-94`), e per i bridged l'errore viene solo loggato. Il purge (unregister) avviene solo al secondo tentativo, che però non viene mai raggiunto: dopo il primo fallimento il codice passa a `failed`.
**Scenario (`repro-missing-fallback.js`):** termostato registrato ma non interrogabile: fallback → `already registered`, retry 1/2 → `already registered`, stato `failed` con endpoint `Thermostat` non funzionante. Nessun update di stato per tutta la sessione.
**Expected:** unregister (ora funzionante) prima di ogni re-register dello stesso UUID.
**Actual:** la recovery non può riuscire.
**Existing test coverage:** "thermostat: async missing registration falls back…" passa solo perché il mock accetta duplicati: test che passa per ragioni sbagliate.
**Suggested fix:** in `registerFallbackAccessory` e nel retry, chiamare prima `topologyCoordinator.unregister(uuid, probe)` e procedere solo se l'assenza è osservata. Aggiornare il mock dei test per rifiutare i duplicati.
**Regression test:** mock che rifiuta UUID duplicati; atteso fallback `TemperatureSensor` interrogabile.
**Confidence:** High.

## [P2] F15 — Handler Matter del termostato: errori assorbiti e attributo non ripristinato

**Category:** API CONTRACT VIOLATION / ROBUSTNESS (già noto: piano 11/09 "non cambiare alla cieca")
**Files:** `src/platform/matter-thermostat-handlers.ts`
**Lines:** `sendTemp` (41-50), `systemModeChange` (125-129)
**Evidence:** i `*Change` handler vengono invocati dopo che matter.js ha già applicato l'attributo. In caso di timeout o rifiuto del pannello l'errore viene solo loggato, e il pannello non cambia, quindi non arriverà nessun realtime a correggere.
**Scenario:** Alexa imposta 23 °C, il pannello rifiuta (`WRITE_CFG_RES RESULT=FAIL`). Matter mostra 23 °C a tempo indefinito, HomeKit mostra 21 °C.
**Expected:** stato Matter riallineato al valore reale, anche senza rilanciare l'errore.
**Actual:** divergenza persistente HAP/Matter.
**Suggested fix:** nel `catch`, ripubblicare lo stato noto (`buildStateUpdates(device)`) tramite la queue: resta coerente con l'echo tracker perché `recordPushed` avviene in `onBeforePush`. Così si evita il loop di retry e si corregge lo stato.
**Regression test:** handler con client che rifiuta; atteso un `updateAccessoryState` con il setpoint precedente.
**Confidence:** High.

## [P2] F16 — Prune HAP immediato su sync parziale (rimozione irreversibile da HomeKit) — presupposto CONFIRMED, aperto

**Stato sul campo:** il pannello risponde a una READ con errore esplicito: `READ_RES PRG_THERMOSTATS` → `RESULT: FAIL, RESULT_DETAIL: CMD_NOT_AVAILABLE`, a ogni login (boot e reconnect). Tutte le altre READ hanno avuto risposta OK. Una `MULTI_TYPES` fallita non è stata osservata. Su questa installazione HAP è disabilitato sul child bridge (solo Matter), quindi l'impatto qui è nullo; resta aperto per le installazioni HAP.

**Category:** ROBUSTNESS (partial sync)
**Files:** `src/platform/accessory-registry.ts`, `src/platform/index.ts`
**Lines:** `accessory-registry.ts:113-129` (unica guardia: zero device scoperti); `index.ts:227-243`
**Evidence:** il prune HAP scatta al primo `REALTIME_RES` e rimuove qualunque accessorio non visto. Lato Matter c'è invece soglia 50% più 3 cicli consecutivi persistiti.
**Scenario:** il pannello risponde con errore o non risponde al `READ MULTI_TYPES` (sotto carico), ma `READ ZONES` e `REALTIME REGISTER` vanno a buon fine. Tutte le luci, tapparelle e termostati vengono `unregisterPlatformAccessories`: in Apple Home si perdono stanze, scene e automazioni.
**Expected:** stessa disciplina di Matter (rapporto minimo più cicli), oppure prune per categoria solo se la categoria ha risposto.
**Actual:** una sola risposta mancante basta.
**Existing test coverage:** solo la guardia "zero device".
**Suggested fix:** riusare `MatterPruneTracker` (o una variante HAP) con persistenza, oppure potare solo le categorie la cui `READ_RES` è arrivata con `RESULT=OK` in questa connessione.
**Regression test:** registry HAP con discovery solo zone, atteso nessuna rimozione di output.
**Confidence:** Medium (dipende dal comportamento del firmware sotto carico; meccanismo certo).

## [P2] F17 — Riscrittura non atomica di `config.json` — osservato sul campo, aperto

**Stato sul campo:** il reset di `generateDebugFile` ha riscritto `config.json` all'avvio (20:41) cambiando la formattazione dell'intero file (non più round-trip identico con indent 4) e senza scrittura atomica. Il contenuto è rimasto intatto.

**Category:** ROBUSTNESS (persistence)
**Files:** `src/platform/config-file-service.ts`
**Lines:** 39 (`fs.promises.writeFile(configPath, …)`)
**Evidence:** read-modify-write diretto sul file principale di Homebridge (reset di `generateDebugFile`, `applyAtStartup` KSA). Gli store del plugin usano invece tmp + `rename`.
**Scenario:** interruzione di corrente o crash durante la scrittura su SD (Raspberry Pi) → `config.json` troncato → **Homebridge intero non si avvia**. Inoltre, salvataggi concorrenti della UI possono perdere aggiornamenti.
**Suggested fix:** scrittura su `config.json.tmp` e `rename`, preservando i permessi del file originale.
**Regression test:** unit test che verifica l'uso di tmp + rename; il file originale resta integro se la serializzazione fallisce.
**Confidence:** High sul meccanismo; probabilità bassa per singolo evento.

## [P2] F18 — `Sentry.init` globale in un processo Homebridge condiviso

**Category:** PRIVACY / COMPATIBILITY
**Files:** `src/telemetry.ts`
**Lines:** 115-131
**Evidence:** `Sentry.init` imposta il client sul carrier globale (`globalThis.__SENTRY__`, per versione SDK). Homebridge esegue più plugin nello stesso processo (bridge principale).
**Scenario:**
- Un altro plugin con la stessa versione di `@sentry/node` e inizializzato dopo sostituisce il client: `captureError` di klares4 viene inviato al DSN dell'altro plugin **senza** `sanitizeEventData` (IP e host nel messaggio).
- Viceversa, gli eventi dell'altro plugin finiscono nel DSN di klares4.
**Expected:** client isolato.
**Actual:** isolamento non garantito.
**Relevant standard/API:** Sentry "Shared environments" best practice (usare un `NodeClient` e uno `Scope` dedicati invece di `init`). RECOMMENDATION.
**Suggested fix:** `new NodeClient({...})` più `new Scope()` con `scope.setClient(client)`, e `scope.captureException(...)`; nessun `Sentry.init`.
**Regression test:** test che verifica che `captureError` usi il client dedicato anche dopo un `Sentry.init` esterno.
**Confidence:** Medium (dipende da altri plugin installati). Si raccomanda comunque, dato che Sentry è opt-out.

## [P2] F19 — Cache KSA parsabile ma incompleta: il client WS non viene mai creato

**Category:** ROBUSTNESS (corrupted persistence)
**Files:** `src/ksa/cache-service.ts`, `src/websocket-client/state.ts`
**Lines:** `cache-service.ts:23-35` (valida solo `thermostatPrograms`); `state.ts:29,32` (`Object.entries(ksaCache.thermostatProgramIdByOutputId)`)
**Scenario (riprodotto):** `klares4-ksa-cache.json = {"thermostatPrograms": []}` (modifica manuale, schema diverso, scrittura parziale di un'altra versione) → `new KseniaWebSocketClient(…)` lancia `Cannot convert undefined or null to object` → `initializeLares4` logga e **nessuna connessione** per tutta la vita del processo.
**Expected:** cache non valida ignorata, con warning.
**Actual:** plugin inutilizzabile con un errore non diagnostico.
**Suggested fix:** in `load()` validare anche le mappe (oggetti) e scartare la cache se incompleta; in `state.ts` usare `?? {}`. Rendere atomica la `save()`.
**Regression test:** cache incompleta, atteso client creato senza preload.
**Confidence:** High sul meccanismo; probabilità bassa.

## [P2] F20 — La cfg del termostato in cache viene riscritta per intero: modifiche fatte dal pannello annullate — NEEDS VERIFICATION, aperto

**Stato sul campo:** non verificato: il test di setpoint dal vivo è stato saltato su richiesta dell'utente (avrebbe acceso riscaldamento o raffrescamento). La cfg letta al boot contiene `ACT_MODE, ACT_SEA, ID, MAN_HRS, SUM, TOF, WIN`.

**Category:** ROBUSTNESS (stale state)
**Files:** `src/websocket-client/command-service.ts`, `src/websocket-client/message-service.ts`
**Lines:** `command-service.ts:159-174, 184-200` (clone dell'intera `thermostatCfgById` in ogni `WRITE_CFG`); `message-service.ts:188-206` (unico aggiornamento da `READ_RES CFG_THERMOSTATS`)
**Evidence:** la cfg viene letta una volta per login (più una lettura "prime" se assente). `CFG_THERMOSTATS` non è nella lista `REALTIME REGISTER` e `STATUS_TEMPERATURES` non la aggiorna. Dopo ogni write la cache viene sostituita dal payload inviato dal plugin.
**Scenario:** l'utente modifica dall'app Ksenia il TM invernale, il TM estivo o altri campi della cfg. Alla successiva scrittura di modo o setpoint dal plugin, questi valori tornano a quelli letti al boot. Questo alimenta anche F06.
**Expected:** scrivere solo i campi cambiati, oppure rileggere la cfg prima della write.
**Actual:** sovrascrittura dell'intero oggetto.
**Suggested fix:** `READ CFG_THERMOSTATS` per l'ID prima di ogni write (c'è già `primeThermostatConfigCache`, da invalidare se la cache ha più di N secondi), oppure payload minimale.
**Confidence:** Medium. NEEDS VERIFICATION: se il pannello applica tutti i campi di un `WRITE_CFG` completo o solo quelli cambiati.

## [P2] F21 — Matter: setpoint di raffrescamento mostrato errato in modalità cool (e possibile seconda write per il deadband)

**Category:** SPEC / ROBUSTNESS
**Files:** `src/platform/matter-thermostat-mapper.ts`, `src/platform/matter-thermostat-handlers.ts`
**Lines:** `matter-thermostat-mapper.ts:195-222` (`occupiedCoolingSetpoint = max(DEFAULT_COOLING, heat + deadband)` a prescindere dalla modalità; il target Ksenia è sempre esposto come heating setpoint); handler `occupiedCoolingSetpointChange`
**Evidence:** codice letto. In modalità cool un target di 26 °C appare su Matter come cooling 28 °C. Se l'utente imposta 27, il pannello memorizza 27 e Matter mostra 29. Inoltre matter.js 0.17.9 `ThermostatServer#reconcileSetpoints` → `#fixSetpointRange` sposta l'altro setpoint per rispettare il deadband quando un setpoint viene scritto (`@matter/node/dist/esm/behaviors/thermostat/ThermostatServer.js`, `#assertOccupiedHeatingSetpointChanging` → `#reconcileSetpoints`). Il valore spostato non corrisponde all'ultimo push, quindi non è un'eco e può arrivare all'handler "cool" come `sendTemp('cool', target+2)`.
**Scenario:** termostato riconosciuto come cooling-capable (dal nome, ad esempio "Climatizzazione"). In heat l'utente imposta 23 con cool a 24: matter.js porta cool a 25, l'handler invia una seconda `WRITE_CFG` a 25 sulla stessa coda del device. Il valore finale dipende dall'ordine degli handler.
**Expected:** in cool il setpoint Ksenia va esposto come `occupiedCoolingSetpoint`; gli aggiustamenti di deadband non vanno inoltrati al pannello.
**Actual:** valore mostrato errato; possibile doppia scrittura.
**Suggested fix:** mappare il target sul setpoint coerente con la modalità e ignorare negli handler le variazioni del setpoint "non attivo".
**Confidence:** High per la visualizzazione. NEEDS VERIFICATION per la doppia write: ordine di invocazione degli handler in Homebridge `ThermostatBehavior`.

## [P2] F22 — PIN numerico in `config.json` scritto in chiaro nel log INFO, nel debug file e non scrubbato in telemetry — NOT REPRODUCED sul campo, FIXED

**Stato sul campo:** NOT REPRODUCED: qui il PIN è una stringa e viene mascherato (`"PIN":"**…"` nel log INFO, `***MASKED***` nella capture). Il PIN reale non compare nella debug capture; le 40 chiavi `PIN` non mascherate sono il flag di un carattere `SCENARIOS[].PIN`. **Fix:** `String(config.pin)` all'avvio; regex del log e capture tolleranti ai numeri.

**Category:** SECURITY / PRIVACY
**Files:** `src/log-levels.ts`, `src/debug-capture/raw-message-capture.ts`, `src/websocket-client/command-service.ts`, `src/platform/index.ts`
**Lines:** `log-levels.ts:22` (regex solo `"PIN":"…"` quotato); `raw-message-capture.ts:13` (maschera solo se `typeof PAYLOAD.PIN === 'string'`); `command-service.ts:52` (`log.info('Sending: …')` a ogni login e reconnect); `platform/index.ts:109-113` (lista di scrub telemetry filtrata a sole stringhe)
**Evidence (eseguito):** `{"CMD":"LOGIN","PAYLOAD":{"PIN":123456}}` resta invariato sia con `maskSensitiveData` sia con `captureRawMessage`.
**Scenario:** l'utente modifica `config.json` con l'editor JSON della UI e scrive `"pin": 123456` (numero). Lo schema dichiara `string`, ma nessuno converte il valore. Il PIN dell'allarme appare nel log INFO a ogni (ri)connessione, e i log vengono spesso allegati alle issue. Compare anche nel debug file "da condividere" e non viene scrubbato dagli eventi Sentry.
**Expected:** PIN mascherato indipendentemente dal tipo.
**Actual:** PIN in chiaro.
**Suggested fix:** normalizzare `String(config.pin)` una volta nel costruttore della piattaforma. Rendere le regex tolleranti ai numeri (`"PIN"\s*:\s*("[^"]*"|\d+)`) e mascherare `PIN` a qualsiasi profondità. Includere `String(pin)` nella lista di scrub. Valutare di non loggare mai il messaggio di LOGIN a livello INFO.
**Regression test:** mask con PIN numerico, sia nel log sia nel debug.
**Confidence:** High.

## [P3] F23 — Percorso di unhandled rejection in `sendKseniaCommand` (riavvio di Homebridge)

**Category:** ROBUSTNESS
**Files:** `src/websocket-client/command-service.ts`
**Lines:** 295-313 (registrazione ACK, poi `outputConfirmation.register` fuori dal `try`)
**Evidence:** se `outputConfirmation.register` lancia ("already has a pending state confirmation"), la promessa ACK già registrata non ha handler. Al timeout scatta `unhandledRejection`, che Node trasforma in `uncaughtException`; Homebridge (`cli.js:82-90`) invia SIGTERM e il bridge si riavvia.
**Scenario:** due comandi concorrenti sullo stesso output ID con chiavi di coda diverse. È raro: richiede che lo stesso output compaia con due prefissi, ad esempio dopo un cambio di categoria sul pannello mentre l'accessorio vecchio è ancora in cache.
**Suggested fix:** spostare le due registrazioni dentro il `try`, oppure registrare la conferma prima dell'ACK.
**Confidence:** High sul meccanismo, Low sulla probabilità.

## [P3] F24 — Shutdown durante un reconnect in corso riprogramma un reconnect

**Category:** ROBUSTNESS (lifecycle)
**Files:** `src/websocket-client/connection-service.ts`
**Lines:** `scheduleReconnect()` (`.catch(() => this.scheduleReconnect())`), `disconnect()`
**Scenario:**
- T0: timer di reconnect → `connect()` in stato CONNECTING.
- T1: shutdown → `disconnect()` → `close()` → abort → `connect()` rifiuta → `.catch` → nuovo timer.
- T1+5 s: tentativo di connessione dopo lo shutdown.

Homebridge termina il processo entro 5 s, quindi l'impatto è limitato.
**Suggested fix:** flag `stopped` impostato in `disconnect()` e verificato nel timer e nel `.catch`.
**Confidence:** High.

## [P3] F25 — Comandi MQTT `retain` rieseguiti a ogni (ri)connessione

**Category:** ROBUSTNESS / MQTT
**Files:** `src/mqtt-bridge/index.ts`
**Lines:** 86-88 (handler `message` ignora `packet.retain`)
**Scenario:** un client pubblica per errore `…/scenario/buonanotte/set` con `retain=true`. A ogni riavvio o reconnect di Homebridge lo scenario viene rieseguito (MQTT-3.3.1-6).
**Suggested fix:** ignorare i messaggi di comando con `packet.retain === true` e loggare un warning; validare i room name contro `+`, `#`, `/`.
**Confidence:** High.

## [P3] F26 — Coda MQTT offline illimitata

**Category:** ROBUSTNESS (memory)
**Files:** `src/mqtt-bridge/index.ts:152-178`; `node_modules/mqtt/build/lib/client.js:1122-1181`
**Evidence:** da disconnessi, i publish QoS 1 (default del plugin) vanno nell'`outgoingStore` in memoria senza limite; al reconnect vengono ri-trasmessi in blocco, con stati obsoleti.
**Suggested fix:** non pubblicare se `!client.connected` e ripubblicare uno snapshot allo stato `connect`; il retain rende inutile la coda.
**Confidence:** High.

## [P3] F27 — Zona bypassata esposta come "manomessa"

**Category:** BEST PRACTICE (HAP semantics)
**Files:** `src/accessories/zone-accessory.ts`
**Lines:** `getStatusTampered`/`updateStatus` (`bypassed ? 1 : 0`)
**Evidence:** `StatusTampered` significa manomissione. Il bypass è già espresso da `StatusActive=false`. Apple Home mostra un avviso di manomissione per ogni zona esclusa.
**Suggested fix:** `StatusTampered` da un campo di tamper reale del pannello, se disponibile, altrimenti 0. Serve una nota nel CHANGELOG: è un cambio visibile.
**Confidence:** High sulla semantica.

## [P3] F28 — I test inviano eventi al Sentry di produzione; `telemetry:false` non è verificato sul trasporto — CONFIRMED, aperto

**Stato:** CONFIRMED: ogni `npm test` tenta 5 invii a `o4511676680699904.ingest.de.sentry.io`. In questa sessione tutti gli invii sono stati bloccati da un preload (`https.request`/`tls.connect`/`dns.lookup` → ENOTFOUND) più `https_proxy` verso una porta chiusa; nessun evento è partito.

**Category:** TEST GAP / PRIVACY
**Files:** `test/telemetry.test.js:117-150`, `src/telemetry.ts:3`
**Evidence:** `initTelemetry(true|undefined)` usa il DSN reale e `captureError(new Error('test error'))`/`captureMessage('test message')` inviano eventi a ogni `npm test`, in CI e in locale. Il test "with false" verifica solo l'assenza di eccezioni.
**Suggested fix:** DSN iniettabile o variabile d'ambiente per i test (ad esempio transport mock con `makeNodeTransport` sostituito); test che asserisce zero chiamate al transport con `telemetry:false`.
**Confidence:** High.

## [P3] F29 — Telemetry: documentazione e realtà divergono; percorsi di stack con username

**Category:** PRIVACY / MAINTAINABILITY
**Files:** `docs/en/config-and-ui.md:76`, `docs/it/configurazione-e-ui.md:76`, README (Telemetry EN/IT), `src/telemetry.ts`
**Evidence:**
- La doc dice "crashes, unhandled exceptions", ma con `defaultIntegrations: false` non c'è cattura globale: solo 2 call site espliciti (`platform/index.ts`).
- I frame di stack contengono percorsi assoluti (`/home/<utente>/…`), non sanitizzati.
- Verified-Plugins: "No analytics or tracking" (REQUIREMENT del programma).
**Suggested fix:** allineare la doc (EN, IT e README); aggiungere `rewriteFramesIntegration`/scrub di `frame.filename`/`abs_path`; valutare l'opt-in se si punta allo stato "Verified".
**Confidence:** High.

## [P3] F30 — CI: Node 24 non testato (usato in release), Node 20 fuori supporto — suite verde su Node 24, aperto (CI)

**Stato:** la suite passa su Node 24.21.0 (lo stesso del container Homebridge) e su 26.8.1; la matrice CI non è stata modificata.

**Category:** COMPATIBILITY
**Files:** `.github/workflows/ci.yml:24` (`node: ['20','22']`), `release-publish.yml` (Node 24)
**Evidence:** Verified-Plugins richiede Node 22 e 24. `connection-service.ts` contiene workaround OpenSSL specifici per Node 24, non coperti da test. Node 20 è EOL da aprile 2026.
**Suggested fix:** matrice `['20','22','24']` (poi rimuovere 20 con un bump di `engines` in una minor, dichiarato).
**Confidence:** High.

## [P3] F31 — Divergenze documentazione ↔ codice

**Category:** MAINTAINABILITY
**Evidence:**
- CHANGELOG rc.2 ("Matter renames work again") e rc.3 (causa attribuita alle "betas") descrivono una diagnosi non corretta per HB 2.4.0 (vedi F01).
- `matterUnregisterTimeoutMs` e `debugCaptureDurationMs` non sono documentati né nel README né in `docs/*`.
- Il README IT non cita `allowInsecureTls` né `commandTimeoutMs`, che il README EN include.
- `ARCHITECTURE.md` elenca `platform-lifecycle-service.ts` e i moduli corretti. OK.
**Suggested fix:** aggiornare README EN/IT e `docs/en` + `docs/it` insieme; nota in `[Unreleased]` (già aggiunta per le fix).
**Confidence:** High.

## [P3] F32 — Persistenze secondarie: downgrade e scrittura non atomica

**Category:** ROBUSTNESS (persistence)
**Files:** `src/platform/matter-fallback-store.ts:107-136`, `src/platform/matter-prune-tracker.ts:99-111`, `src/ksa/cache-service.ts:19-21`
**Evidence:**
- Il fallback store tratta un `version` futuro come "legacy": record vuoti, poi, alla prima scrittura, sovrascrive il file (con backup `.v1.bak` solo la prima volta).
- Il contatore di prune e la cache KSA scrivono senza tmp + rename. Per il prune la direzione di errore è sicura (contatori azzerati, quindi meno prune).
**Suggested fix:** rifiutare in sola lettura le versioni sconosciute (non riscrivere); tmp + rename ovunque.
**Confidence:** High.

## [P3] F33 — Termostato Matter: un retry dello stesso valore entro 10 s viene scartato dopo un errore

**Category:** ROBUSTNESS
**Files:** `src/platform/matter-thermostat-handlers.ts`, `src/platform/matter-thermostat-echo-tracker.ts`
**Lines:** `recordIntent` chiamato prima di `sendTemp`/`setThermostatMode`
**Scenario:** comando fallito (timeout); l'utente riprova lo stesso valore entro il TTL (10 s) e il retry viene scambiato per un'eco e ignorato. Due pressioni rapide di raise/lower calcolano dallo stesso `device.targetTemperature` non ancora aggiornato.
**Suggested fix:** registrare l'intent solo dopo l'esito, oppure cancellarlo nel `catch`.
**Confidence:** Medium-High.

## [P3] F34 — Loop infinito teorico nel fallback dei nomi Matter

**Category:** ROBUSTNESS
**Files:** `src/platform/matter-name-sanitizer.ts:256-260`, `src/platform/matter-name-map.ts:62-65`
**Evidence:** `buildUuidFallbackSuffix(`${base} ${n}`, uuid, …)` tronca la testa. Con un `base` lungo il suffisso numerico viene tagliato, quindi ogni iterazione produce lo stesso candidato; se lo slot è di un altro UUID il `for (;;)` non termina e blocca l'event loop di Homebridge. Con ID corti i tag 4..12 collassano in pochi candidati distinti. Riprodotto in seconda passata con nomi costruiti ad arte.
**Suggested fix:** troncare `base` prima di aggiungere ` ${n}`, oppure limitare il ciclo e ricadere su un suffisso con l'ID completo.
**Confidence:** High sul meccanismo, probabilità molto bassa.

## [P3] F35 — Import `.ksa`: lookup su proprietà ereditate ed entry `null`

**Category:** ROBUSTNESS (input non affidabile)
**Files:** `src/ksa/derive.ts`
**Lines:** ≈84, ≈104 (lookup su `Record` plain object)
**Evidence (seconda passata):**
- Un ID termostato `"constructor"` produce una coppia con `domusSensorId` funzione; una stanza con ID `"toString"` produce una stanza senza nome, e con `applyAtStartup` finisce in `config.json`.
- Un `null` in un array `PRG_*` fa fallire l'intero import (errore catturato, fallback sulla cache).
- Nessuna prototype pollution reale: `__proto__` viene scartato da `JSON.parse`/assegnazione.
**Suggested fix:** `Object.create(null)`/`Map` e `Object.hasOwn`; saltare le entry non-oggetto.
**Confidence:** High (input improbabile: il file viene dalla centrale dell'utente).

## [P3] F36 — Lifecycle di debug capture e lista device allo shutdown

**Category:** ROBUSTNESS
**Files:** `src/platform/index.ts:204-206`, `src/debug-capture/index.ts:53-65`, `src/platform/device-list-service.ts`
**Evidence:** il `DebugCaptureManager` non viene conservato né fermato su `shutdown`, e i suoi timer non sono `unref`. Un riavvio durante la capture (fino a 30 min) perde il file. Il `JSON.stringify(…, null, 2)` finale è sincrono su tutti i messaggi (duplicati come `rawData` e `parsed`). Il timer di scrittura di `klares4-devices.json` non viene cancellato né eseguito allo shutdown, e la scrittura non è atomica. Il file non viene riletto dal plugin, quindi l'impatto è minimo.
**Suggested fix:** fermare la capture e fare flush su `shutdown`; `unref()` dei timer.
**Confidence:** High.

---

## [P1] F37 — Unregister "osservato" troppo presto: il register successivo viene rifiutato come `already registered` — FIXED (verificato sul campo)

**Category:** API CONTRACT / RACE (trovato sul campo)
**Files:** `src/platform/matter-topology-coordinator.ts`
**Evidence (campo, rename di `light_37`):** `Unregistering 1 Matter accessory` → prima probe `getAccessoryState` già `undefined` → `register requested … [rename]` → `[Matter/ChildManager] Failed to register … "light_37" is already registered` → solo dopo `Unregistered Matter accessory: PC (light_37)`. Il rename è rimasto senza endpoint per circa 30 s, finché il retry F14 non l'ha recuperato. In `homebridge/dist/matter/server/AccessoryManager.js`, `unregisterAccessory` fa `await accessory.endpoint.close()` e solo dopo `deps.accessories.delete(uuid)`; durante la chiusura `StateManager.getAccessoryState` risponde già `undefined`.
**Impact:** ogni rename, recovery o re-register dopo un unregister rischia il rifiuto. Senza il retry F14 (quindi nella rc.3 anche con la fix F01) il rename non si applica mai.
**Fix:** dopo la prima assenza osservata il coordinator attende un periodo di assestamento (default 1000 ms, `KLARES4_MATTER_UNREGISTER_SETTLE_MS`) prima di considerare l'endpoint rimosso. Sul campo la chiusura richiede molto meno di 1 s.
**Regression test:** `test/matter-registration-race.test.js` "F37 …" (il mock HB 2.4 modella la finestra di chiusura con `unregisterCloseMs`).
**Verifica dopo la fix:** rename `PC Test Audit` → `PC Test Audit 2`: `register requested [rename]` e `registered` nello stesso secondo, zero `already registered`, nessun retry.
**Confidence:** High.

## [P1] F38 — Un salvataggio dalla Homebridge UI imposta `exposed: false` su tutti i `matterOverrides` (device poi potati da Matter) — FIXED

**Category:** COMPATIBILITY / CONFIG INTEGRITY (trovato sul campo)
**Files:** `config.schema.json` (`matterOverrides.items.exposed`), `src/platform/discovery-service.ts`
**Evidence (campo):** stesso salvataggio UI di F02. Prima: 18 override `{ deviceId, name }` senza `exposed`. Dopo: tutti e 18 con `"exposed": false`. Lo schema dichiarava `exposed` come boolean senza default e la UI materializza la checkbox non toccata come `false`. Nello stesso salvataggio: aggiunta una voce `matterRecoveryRequests` senza `deviceId` (`{ generation: 1 }`, ignorata dal normalizzatore) e `matterUnregisterTimeoutMs: 3000` (default); `maxSeconds` è passato da 30 a 20 (probabilmente la modifica "innocua" dell'utente).
**Impact:** al riavvio successivo i 16 contatti e 2 scenari con override risultano non esposti; il prune tracker li rimuove da Matter dopo 3 cicli (ogni boot o reconnect è un ciclo), e in Apple Home, Alexa e Google si perdono stanze e automazioni. L'installazione è stata protetta ripristinando subito il config; sull'host c'è un aggiornamento automatico dell'immagine alle 05:00 che avrebbe riavviato con il config rovinato.
**Fix:** `"default": true` sulla checkbox (descrizione in UI: deselezionare per nascondere; se selezionata, forza l'esposizione anche con la categoria disattivata); warning all'avvio che elenca i device nascosti da un override, per individuare le configurazioni già colpite; test di schema che rifiuta boolean senza default negli item di array e mappe `additionalProperties`/`patternProperties`.
**Round-trip UI del nuovo schema:** PENDING, da ripetere con un salvataggio dalla UI sulla build finale.
**Confidence:** High.

## [P3] F39 — Nessun timeout applicativo sulla connessione WebSocket

**Evidence (campo):** con il traffico verso il pannello scartato, il tentativo `Attempting reconnection (attempt 1)` è rimasto appeso dalle 20:43:25 alle 20:45:38 (`connect ETIMEDOUT`, timeout TCP del kernel), prima di programmare il tentativo successivo.
**Impact:** dopo un blackout di rete, la riconnessione può tardare fino a circa 2 minuti oltre il ritorno del pannello.
**Suggested fix:** timeout di connessione e handshake (per esempio 10 s) in `connection-service.ts`, poi il normale backoff.
**Confidence:** High.

## [P3] F40 — Il file di debug riporta una versione obsoleta — FIXED

**Evidence (campo):** `klares4-debug-*.json` → `"version": "1.1.9-beta0"` con il plugin 2.2.0-rc.3.
**Impact:** diagnosi più difficili sui file allegati alle issue.
**Fix:** `PLUGIN_VERSION_RAW` in `debug-capture/file-generator.ts`; test `test/debug-file-version.test.js`.
**Confidence:** High.

---

# Tests missing

| Area | Missing scenario | Risk | Suggested test |
|---|---|---|---|
| Discovery | Secondo sync (reconnect) non deve regredire lo stato | Alto (F03) | pipeline `MessageService` con due `MULTI_TYPES` |
| Termostati | Setpoint in stagione SUM senza hint; hint stale rispetto al pannello | Alto (F06) | `buildThermostatSetpointCommandPayload` + `CommandService` |
| Termostati | Cfg modificata dal pannello tra due write | Medio (F20) | `CommandService` con due `READ_RES` e una write |
| Termostati Matter | Modalità cool: setpoint mostrato e deadband | Medio (F21) | `buildThermostatMatterState` in cool |
| Secret | PIN numerico nei log e nel debug file | Medio (F22) | `maskSensitiveData`, `captureRawMessage` |
| Matter | Dimmer: capability appresa dopo la registrazione | Alto (F04) | registry + mapper, atteso `DimmableLight` |
| Matter | register/updateState concorrenti durante una recovery | Alto (F05) | `repro-race-hb24.js` come test |
| Matter | Mock con semantica HB 2.4: duplicate UUID rifiutato, `getAccessoryState` per cluster, unregister che richiede `deviceType` | Alto (test attuali passano per ragioni sbagliate) | aggiornare `makeApi` nei test registry |
| HAP | Prune su sync parziale (solo zone) | Medio | `AccessoryRegistry` |
| Config | `customNames` in forma array + map legacy; guardia schema anti-`additionalProperties` | Alto | stile `matter-override-config.test.js` |
| Commands | Reconnect con comandi pendenti; shutdown con comando pendente | Medio | server `ws` locale (harness in `websocket-connection-lifecycle.test.js`) |
| Commands | Evento realtime fuori ordine (stato vecchio dopo il comando) | Medio | `OutputCommandConfirmationTracker` + `StatusUpdater` |
| Commands | Messaggio senza `CMD`/`STA` (payload malformato) non interrompe l'elaborazione del resto | Basso | `MessageService.handleMessage` |
| Matter handlers | Fallimento del comando termostato → riallineamento attributo | Medio | `matter-thermostat-handlers` |
| Persistence | Cache KSA incompleta, `config.json` troncato, store con versione futura | Medio | unit test per gli store |
| Telemetry | Transport mock: nessun invio con `telemetry:false`; stack frame senza home dir | Medio | `telemetry.test.js` |
| MQTT | Comando `retain`, payload malformato su topic valido, broker offline | Basso | `mqtt-bridge-index.test.js` |
| HAP | Valori fuori range dal pannello (target 5 °C con min 10) | Basso | `hap-accessories.test.js` |
| KSA | File troncato, marker assente, JSON enorme, chiavi `__proto__` | Basso | `ksa-import.test.js` |
| CI | Node 24 | Medio | matrice CI |

---

# Improvement opportunities

| Opportunità | Problema prevenuto | Costo | Rischio | Priorità |
|---|---|---|---|---|
| Mock Matter unico "fedele a HB 2.4" condiviso fra i test | test verdi con semantica irrealistica (F01, F14) | basso | nullo | alta |
| "Registration gate" per `device.id` (in-flight map) estratto dal registry | race di doppia registrazione; libera righe sotto il gate 350 | basso | basso | alta |
| Disciplina di prune unica HAP/Matter (tracker persistito) | rimozioni HAP su sync parziale | medio | medio | media |
| Scritture atomiche centralizzate (`writeJsonAtomic`) | `config.json`/cache corrotti | basso | basso | media |
| Client Sentry isolato (`NodeClient` + `Scope`) | leak cross-plugin | basso | basso | media |
| Stato di discovery separato dallo stato osservato (merge per id) | regressioni di stato a ogni reconnect | medio | medio | alta |
| Log a livello `warn` quando una chiamata topologica Matter lancia un'eccezione | diagnosi invisibili (F01 era a livello debug) | minimo | nullo | alta |

---

# Architecture consistency

| Invariante | Esito | Note |
|---|---|---|
| Facade `platform.ts`, `websocket-client.ts`, `mqtt-bridge.ts`, `debug-capture.ts`, `types.ts` senza business logic | PASS | solo `export *` |
| Test caricano `dist/`; nessuna conclusione da `dist/` obsoleto | PASS | `npm test` esegue `build`; ogni verifica è stata fatta dopo `npm run build` |
| Write ≠ success (`requested → sent → acknowledged/state-confirmed`) | PARTIAL → migliorato | dispatcher e command service rigorosi. Violazioni trovate: fallback su ID ritirati (fixed), termostato HAP senza client (fixed), handler Matter termostato che assorbono gli errori (aperto, F15), `setBrightness` durante la finestra di rediscovery (F03), setpoint con ACK positivo ma payload che non cambia il valore (aperto, F06) |
| Device ID come identità canonica (UUID HAP, UUID Matter, topic MQTT via id/slug) | PASS | UUID HAP = `uuid.generate(device.id)`, UUID Matter = `device.id`; `OutputTypeMemory` evita flip di prefisso. Slug MQTT derivato dal nome (by design) |
| Per-device config come array tipizzati | FAIL | `customNames` (F02) |
| Matter registration truth boundary (`requested → published-unverified → locally-published`) | PARTIAL | modello corretto; però "unregister chiamato" veniva confuso con "rimozione tentata" (stub). La probe per cluster (`getAccessoryState` restituisce `undefined` anche per cluster mancante) può scambiare "cluster assente" per "endpoint assente" |
| Nomi Matter layer separato (no mutazione HAP/MQTT/source) | PASS | `applyMatterName` restituisce una copia; test esistenti |
| Voice analyzer read-only | PASS | nessuna scrittura su device o entry (verificato anche in seconda passata) |
| Pruning resistente ai partial sync | PARTIAL | Matter: PASS (50% più 3 cicli persistiti); HAP: FAIL (F16) |
| Telemetry attraverso `sanitizeEventData` | PASS con riserva | unico `beforeSend`; nessuna chiamata diretta a Sentry fuori da `telemetry.ts`; riserva su client globale (F18) e stack path (F29) |
| `telemetry:false` impedisce l'invio | PASS (codice) / NOT VERIFIED (test di trasporto) | `initTelemetry` non chiama `Sentry.init`; `captureError` no-op |
| Compatibility contract (alias, config keys, topic shape, UUID, classi esportate) | PASS | nessuna modifica introdotta dalle fix; `parseCommandTopic` ha un parametro opzionale additivo |
| `max 350 righe` | PASS | `matter-accessory-registry.ts` 348 |

---

# Adversarial scenarios

| Scenario | Esito dell'analisi | Coperto da test |
|---|---|---|
| Pannello offline all'avvio | Il WS si riconnette; MQTT e debug erano persi (fixed) | Sì, nuovo `platform-startup.test.js` |
| Pannello che cade durante un comando | `close` → `rejectAllPendingCommands` + `outputConfirmation.rejectAll` → HAP -70402 | Parziale (dispatcher), non end-to-end |
| ACK in ritardo | Dopo il timeout veniva attribuito a un altro comando (fixed) | Sì, nuovo |
| ACK duplicato | Dopo il primo settle l'ID è ritirato, il duplicato viene ignorato (fixed) | Sì, stesso meccanismo |
| Evento realtime prima dell'ACK | Conferma di stato, poi l'ACK tardivo viene ignorato (fixed) | Sì |
| Evento realtime dopo il timeout | Aggiorna lo stato; il comando resta fallito (corretto) | No |
| Reconnect con comandi pending | Pending rifiutati; eventi di socket vecchi ignorati (fixed) | Parziale |
| Shutdown durante un reconnect | Reconnect riprogrammato (P3) | No |
| MQTT reconnect ripetuto | Re-subscribe per `connect`; comandi `retain` rieseguiti (P3); coda offline illimitata (P3) | No |
| Homebridge restart | UUID stabili; name-map persistito; il context HAP salva `dimmable` | Sì (Matter two-boot) |
| Config parzialmente errata | IP/PIN mancanti → nessuna connessione; termostato riportava successo (fixed); override malformati scartati | Parziale |
| Device rinominato | HAP displayName riallineato; Matter rename ora effettivo (F01); slug MQTT cambia | Parziale |
| Device rimosso | HAP: prune immediato; Matter: 3 cicli (ora l'unregister funziona) | Sì (Matter con mock) |
| Device temporaneamente assente | HAP: rimosso subito se la categoria manca (F16); Matter: protetto | Solo Matter |
| Discovery incompleta | vedi sopra | Solo Matter |
| Registrazione Matter fallita a metà | Probe → fallback / retry; re-register senza unregister (F14) | Sì, ma con mock irrealistico |
| Persistence corrotta | JSON corrotto gestito per name/fallback/prune; cache KSA incompleta blocca l'avvio (F19) | Parziale |
| Eccezione telemetry con credenziali | IP, URL e valori di config scrubbati; IPv6 risolto non scrubbato se l'host è un nome DNS; path con username non scrubbati | Parziale |
| File `.ksa` malformato | Errore catturato, uso della cache precedente, nessun crash; entry `null` annulla l'import (F35) | Parziale (solo caso felice) |
| Setpoint in estate dopo un restart / stagione cambiata dal tastierino | Modifica persa oppure centrale portata in raffrescamento (F06) | No |

# Second pass

Eseguita dopo il primo audit con due revisioni indipendenti in sola lettura, e con verifica diretta da parte dell'auditor di ogni finding prima dell'inclusione.

1. **Moduli coperti in modo leggero nel primo giro:**
   - termostati (payload, stagioni, resolver, DOMUS);
   - mapper e handler Matter del termostato, echo tracker;
   - sanitizer dei nomi e voice analyzer;
   - derive KSA, debug capture, device list.

   Risultato: F06, F20, F21, F22, F33, F34, F35, F36. F06 e F22 sono stati rieseguiti dall'auditor contro `dist/`; F21 e F34 sono stati verificati sul codice di matter.js e del plugin.
2. **Revisione avversariale delle fix applicate.** Ha trovato due problemi reali, corretti con test:
   - la fix del prefisso MQTT toglieva lo slash finale e rompeva `klares4//stanza/…/set`;
   - la fix della tapparella forzava STOPPED durante un movimento ancora valido.

   Ha confermato l'assenza di violazioni del compatibility contract e l'innocuità del passaggio dell'accessorio completo all'unregister (emit in-process, nessuna IPC). Ha segnalato due residui preesistenti nel connection service (documentati in F09).
3. **Differenze `src/` ↔ `dist/`:** ogni verifica è stata fatta dopo `npm run build`; `dist/` non è versionato (`.gitignore`), quindi non esiste un `dist/` obsoleto nel repository.
4. **Test che passavano per ragioni sbagliate:**
   - `matter-topology-coordinator.test.js` "unregister trusts observation over a throwing API call";
   - "thermostat: async missing registration falls back…" (mock che accetta UUID duplicati);
   - il mock `getAccessoryState`, che ignora il cluster;
   - `telemetry.test.js` "with false does not initialize" (non verifica il trasporto).
5. **Codice morto o percorsi non testati:**
   - il percorso "stale-endpoint purge" (secondo tentativo) non era raggiungibile con HB 2.4 (F14);
   - il percorso degradato "DOMUS sensor id come cfg id" senza PRG_THERMOSTATS può colpire il termostato sbagliato con coppie incrociate. È intenzionale e testato come tale; da mantenere solo come fallback esplicito (NEEDS VERIFICATION sul campo).
6. **Verificato OK in seconda passata:**
   - voice analyzer strettamente read-only e deterministico;
   - enum SystemMode (Off 0, Auto 1, Cool 3, Heat 4) e limiti dei setpoint Matter (heat 500–3000, cool 1600–3500, deadband 20 in 0.1 °C);
   - echo tracker limitato;
   - matching `STATUS_TEMPERATURES` per sensore DOMUS;
   - validazione di `matter-override-config` in forma array.

---

# Suggested roadmap

> **Aggiornamento dopo la verifica sul campo.** I punti 1-8 e 10 di "Before stable release" sono corretti e coperti da test (per F10 vale il mock HB 2.4 condiviso `test/fixtures/hb24-matter-api.js`); a questi si aggiungono F37 e F38, trovati sul campo. Restano per la stable: il round-trip UI del nuovo schema (F02/F38) e un soak di qualche giorno con reconnect. Il resto della roadmap è invariato.

**Before stable release** (ognuno con ragione concreta)

1. F01 unregister (fatto: da committare con i test).
2. F02 `customNames` in forma array: perdita silenziosa di configurazione, già vista in produzione per lo stesso schema.
3. F03 rediscovery che regredisce lo stato: eventi spuri a ogni reconnect.
4. F04 dimmer Matter: funzione mancante a ogni avvio.
5. F05 gate di registrazione in volo: la recovery termostato non funziona senza.
6. F06 stagione nel payload del setpoint: controllo errato dell'impianto (riscaldamento/raffrescamento) o comando inefficace riportato come riuscito.
7. F22 PIN normalizzato a stringa e mascheramento robusto: secret dell'allarme nei log INFO; fix di poche righe.
8. F14 unregister prima del re-register nei percorsi di recovery: ora possibile grazie a F01.
9. Commit delle fix P2 già applicate (MQTT prefix, avvio offline, socket stale, ACK tardivi, cover, termostato, dimmer HAP).
10. Aggiornare il mock Matter dei test alla semantica HB 2.4 (vedi *Tests missing*).

**Next patch**

- F15 riallineamento attributi del termostato Matter; F21 mapping heat/cool e deadband; F33 intent dopo l'esito.
- F20 rilettura o patch minima della cfg termostato (dopo la verifica sul pannello).
- F16 prune HAP resistente ai partial sync.
- F17 `config.json` atomico.
- F19 validazione della cache KSA.
- F23 unhandled rejection.
- F24 flag `stopped`.

**Next minor**

- F18 client Sentry isolato.
- F28 test telemetry senza DSN reale.
- F30 matrice Node 22/24 (e decisione su Node 20 / `engines`).
- F27 semantica tamper (cambio visibile).
- Documentazione (F31).

**Optional**

- F25/22 hardening MQTT (retain, coda offline, room name).
- F32 persistenze secondarie.
- F34 loop dei nomi, F35 lookup KSA, F36 lifecycle della capture.
- F29 telemetry opt-in se si punta allo stato Verified.

**Giudizio.** Con le fix applicate e i punti "Before stable release" risolti e coperti dai test indicati, il plugin può essere dichiarato stabile per HomeKit + MQTT. Per Matter servono anche la validazione su un bridge reale HB 2.4.x e un soak di almeno qualche giorno con reconnect provocati.

---

# Files changed

**Fase di verifica sul campo e correzioni (2026-09-26)**

| File | Motivo |
|---|---|
| `src/platform/matter-registration-gate.ts` (nuovo) | F05: una registrazione in volo per device |
| `src/platform/matter-light-capability.ts` (nuovo) | F04: upgrade a `DimmableLight`, capability dalla cache |
| `src/platform/matter-registration-recovery.ts` | F14: unregister prima di fallback e retry; `handleRegisterFailure` spostato qui dal registry (limite 350 righe) |
| `src/platform/matter-topology-coordinator.ts` | F37: assestamento dopo la prima assenza osservata |
| `src/platform/matter-accessory-registry.ts` | F03/F04/F05: gate, upgrade dimmer, stato di boot dalla cache |
| `src/device-observation.ts`, `src/websocket-client/discovered-device.ts` (nuovi) | F03: placeholder di discovery e merge con lo stato noto |
| `src/websocket-client/message-service.ts`, `src/websocket-client/index.ts`, `src/platform/accessory-registry.ts` | F03 |
| `src/websocket-client/thermostat-write-payload.ts`, `thermostat-command-payload.ts`, `command-service.ts`, `thermostat-status-updater.ts`, `types.ts` | F06: `ThermostatSeasonTracker`, patch per la stagione attiva |
| `src/log-levels.ts`, `src/debug-capture/raw-message-capture.ts`, `src/platform/index.ts` | F22 |
| `src/platform/custom-names-config.ts` (nuovo), `src/platform/types.ts`, `discovery-service.ts`, `ksa-import-service.ts`, `config.schema.json` | F02, F38 |
| `src/debug-capture/file-generator.ts` | F40 |
| `README.md`, `docs/en/config-and-ui.md`, `docs/it/configurazione-e-ui.md`, `CHANGELOG.md` | documentazione utente (EN e IT) |
| `test/fixtures/hb24-matter-api.js` (nuovo) e 8 file di test nuovi; `test/matter-accessory-registry.test.js` aggiornato | regressioni con semantica HB 2.4 |

**Fase statica (commit precedente)**

Nessun commit e nessun push, come richiesto.

| File | Motivo |
|---|---|
| `src/platform/matter-topology-coordinator.ts` | F01: `remember()`, mappa degli accessori noti, unregister con l'accessorio reale |
| `src/platform/matter-accessory-registry.ts` | F01: `topologyCoordinator.remember()` in `configureCachedAccessory` (+1 riga) |
| `src/mqtt/topic-parser.ts` | F07: `parseCommandTopic(topic, topicPrefix?)` |
| `src/mqtt-bridge/index.ts` | F07: passa `this.topicPrefix` |
| `src/platform/index.ts` | F08: MQTT e debug capture prima di `await connect()` |
| `src/websocket-client/connection-service.ts` | F09: guardia `isCurrent()` per socket; reset di `isManualClose` a ogni tentativo |
| `src/websocket/command-dispatcher.ts` | F10: set limitato di ID ritirati |
| `src/accessories/cover-accessory.ts` | F11: ripristino di target e stato precedenti dopo un fallimento |
| `src/accessories/thermostat-accessory.ts` | F12: guardia sul client WS |
| `src/accessories/light-accessory.ts` | F13: binding lazy degli handler Brightness |
| `CHANGELOG.md` | voci `[Unreleased]` → `### Fixed` per le fix utente-visibili |
| `test/matter-topology-coordinator.test.js` | 2 test con semantica HB 2.4 |
| `test/matter-accessory-registry.test.js` | opzione `initiallyQueryable` nel mock più 1 test di recovery |
| `test/mqtt-topic-parser.test.js` | 2 test sul prefisso (profondità qualsiasi, slash finale) |
| `test/websocket-command-dispatcher.test.js` | 2 test su ACK tardivi e duplicati |
| `test/hap-accessories.test.js` (nuovo) | harness HAP reale: cover (2), termostato, dimmer |
| `test/websocket-connection-lifecycle.test.js` (nuovo) | server `ws` locale: socket stale e reconnect |
| `test/platform-startup.test.js` (nuovo) | avvio con pannello offline e MQTT |
| `AUDIT_REPORT.md` (nuovo) | questo report |

Documenti da aggiornare per le fix utente-visibili: solo il CHANGELOG (già fatto). Per F02 serviranno anche README EN/IT e `docs/en|it/config*`.

Non sono stati toccati `CLAUDE.md`/`AGENTS.md` (assenti e in `.gitignore`), dati del pannello, file `.ksa` né `research/`.

---

# Commands executed

| Comando | Risultato |
|---|---|
| `npm ci` | OK |
| `npm run check:max-lines` | OK (baseline e finale) |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` | OK (baseline e finale) |
| `npm test` (Node 22) | baseline 274/274; finale 287/287 |
| `npm run build` | OK |
| `node --test …` con `/opt/node20/bin` (Node 20.20.2) | 287/287 |
| `npm audit`, `npm audit --omit=dev` | 0 vulnerabilità |
| `npm outdated` | solo minor/patch disponibili (`@sentry/node` 10.75.3, `ws` 8.22.0); nessun upgrade necessario per i finding |
| `node repro-recovery-race.js` (mock con register che lancia su duplicato) | doppia registrazione; store `native` con endpoint `TemperatureSensor` |
| `node repro-missing-fallback.js` | fallback e retry → `already registered` → `failed` |
| `node repro-unregister.js` (mock HB 2.4) | `TypeError … 'deviceType'` → timeout → `recovery-unregister-timeout` |
| `node repro-pipeline.js` | stato regredito ai default al secondo sync; `dimmable:false` in discovery |
| `node repro-matter-dimmer.js` | endpoint `OnOffLight`, update `levelControl` rifiutato |
| `node repro-race-hb24.js` / `repro-norace-hb24.js` | race → `TemperatureSensor`/`fallback`; senza race → `Thermostat`/`native` |
| Test mirati `node --test test/<file>` prima e dopo ogni fix | falliti prima, passati dopo (TDD) |
| Ispezione di `node_modules/homebridge/dist/matter/**`, `cli.js`, `@homebridge/hap-nodejs`, `mqtt/build/lib/client.js`, `@matter/types` | vedi riferimenti nei finding |

Gli script di riproduzione si trovano nella scratchpad della sessione e non sono stati aggiunti al repository.
