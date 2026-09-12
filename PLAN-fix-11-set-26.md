# Piano di remediation — 11 settembre 2026

Baseline verificata: `origin/main` al commit `8aeffb43bd69d47b7f04c3b23787730b48c38246`. La produzione usa `v2.1.5-rc.1` (`92ec1eda88ff6c3e74679c7cb7837ad76b71ef2d`), che contiene modifiche di name reservation e pruning non presenti su `main`. Il piano preserva device ID, UUID, bridge identity, fabric, commissioning Matter e comportamento HAP/MQTT.

# 1. Audit validation

| Finding audit | Stato su `main` | Evidenza | Gravità | Fix |
|---|---|---|---|---|
| Stabilità nella finestra osservata | runtime-dependent | I log forniti coprono circa cinque ore | P1/P3 | soak e retention |
| Build/test verdi | confermato con differenza | `origin/main`: `npm run verify`, 225/225 test; 244 appartengono alla RC | P3 | no |
| Produzione RC, npm latest 2.1.4 | confermato | `rc=2.1.5-rc.1`, `latest=2.1.4` | P1 | riconciliare release |
| Matter 109 → 53 | runtime-dependent, meccanismo confermato | `matterExposure` è applicato solo al percorso Matter | P1 | hardening prune |
| HAP non ridotto da `matterExposure` | confermato | registrazione HAP separata | — | preservare |
| Naming solo exact case-insensitive | confermato | `matter-name-map.ts` | P2 | analyzer read-only |
| Collisioni Alexa | lessico confermato, NLU runtime-dependent | fixture e nomi; indice Alexa non osservabile | P2 | analyzer + override mirati |
| Scenario/gate come presa | confermato, intenzionale | `matter-device-mapper.ts` | P2 | mantenere ora |
| Comandi mutativi non attendono ACK | confermato | `switchLight`, `dimLight`, `moveCover`, `toggleGate`, `triggerScenario` | P0 | sì |
| Alcuni firmware non inviano ACK output | confermato dalla storia | commit `74aa9fa`; producono realtime | P0 | ACK oppure state confirmation |
| Dispatcher non valida RESULT | confermato | `resolvePendingCommand` usa ID/CMD | P0 | sì |
| CMD_NOT_AVAILABLE invisibile | parziale | rejection reale, ma `GENERIC/ERROR` non sempre correlabile | P0 | correlare solo senza ambiguità |
| Termostati attendono WRITE_CFG_RES | confermato | command service | P0 | validare RESULT |
| Correlazione exact ID + fallback | confermato | fallback solo con singolo pending compatibile | P0 | hardening |
| ID pending potenzialmente duplicato | confermato | nessun controllo collisione | P0 | sì |
| Nessun command→state tracker | confermato | status updater non chiude pending | P0/P3 | sì per device osservabili |
| Log sent/executed ottimistici | confermato | command service/accessori/MQTT | P0 | sì |
| Errori HAP propagabili | confermato | `HapStatusError` | — | preservare |
| Termostati Matter assorbono errori | confermato | protezione contro retry loop | P1 | non cambiare alla cieca |
| Fallback termostato sticky | confermato | marker forza sempre TemperatureSensor | P1 | recovery esplicita |
| Retry iniziale bounded | confermato | `matter-registration-recovery.ts` | P1 | estendere post-restart |
| Fallback store povero/non versionato | confermato | set di device ID | P1/P3 | store v2 |
| Name store permissivo | confermato | versione/invarianti incomplete | P1 | store v2 |
| Reservation 30 giorni | presente solo nella RC | assente su `main` | P1 | port selettivo |
| Prune guard RC | presente solo nella RC | assente su `main` | P1 | port selettivo |
| Suffix incrementale non ricontrollato | confermato | `suffixFor` | P1 | sì |
| `_` conservato nel suffix | confermato | `buildUuidFallbackSuffix` | P1 | sì |
| Unicode/troncamento | confermato | nessuna NFKC, uso di `slice` | P1/P2 | sì |
| Determinismo batch | confermato per input validi | priorità + device ID | — | preservare |
| Provenance assente | confermato | `applyCustomName` muta il device | P3/P2 | struttura derivata |
| `roomMapping` solo MQTT | confermato | `mqtt-bridge/index.ts` | P2 | non riusarlo implicitamente |
| Catalogo per controller nello stesso node | non supportato | topology comune alle fabric | — | no |
| update API aggiorna NodeLabel runtime | falso | Homebridge fonde cache, non endpoint runtime | P1 | lifecycle verificato |
| await register/unregister attende davvero | falso | API bridged emette evento asincrono | P1 | coordinator |
| Probe dimostra Alexa | falso | prova solo queryability locale | P1/P3 | stati espliciti |
| 42 warning lock | runtime-dependent, rischio coerente | operazioni API possono sovrapporsi | P1 | serializzazione |
| Output type memory solo process | confermato | memoria di modulo | P3 | differire |
| Log per-device verbosi | confermato | name finalizer | P3 | summary/hash |
| Vulnerabilità MQTT transitiva | già risolta su `main` | audit corrente: zero vulnerabilità prod | — | no |
| Identità stabile | confermato | Matter usa `device.id`, HAP UUID derivato | — | vincolo |

# 2. Current architecture

```text
Matter/HAP/MQTT handler
  → KseniaWebSocketClient
  → CommandService
  → coda per device
  → sendKseniaCommand
  → WebSocket transport
  → MessageService / ProtocolRouter
  → CommandDispatcher
  → Promise del chiamante
```

La discovery crea `KseniaDevice`; oggi `customNames` muta globalmente `name` e `description`. Matter applica poi eligibility, name map, mapper, registry, recovery e pruning.

Livelli di verità obbligatori:

```text
requested → sent → acknowledged
                 ↘ state-confirmed

requested → published-unverified → locally-published
                                   ≠ controller-observed
```

`controller-observed` resta `unknown` nel plugin.

# 3. Dependency graph

```text
response schema + ID univoco
  → correlazione exact/single-compatible
  → CommandOutcome
  → ACK/rejection/timeout affidabili
  → tracker realtime
  → handler e log veritieri
```

```text
validazione name store
  → store v2 + reservation
  → ResolvedDeviceNames
  → analyzer read-only
  → matterOverrides
```

```text
topology coordinator
  ├─→ rename verificabile
  ├─→ pruning ordinato
  └─→ recovery termostato con rollback
```

Ordine obbligatorio: baseline → command correctness → store/provenance → analyzer → topology coordinator → policy per-device → recovery termostato.

# 4. Priority matrix

| Priorità | Scope |
|---|---|
| P0 | RESULT/RESULT_DETAIL, correlazione, ID univoco, ACK-or-state, log/Promise veritieri |
| P1 | store validi, reservation/prune RC, topology coordinator, rename, thermostat recovery |
| P2 | analyzer voice-first, override Matter-only, exposure per device |
| P3 | provenance, summary/hash, metriche e retention |

# 5. Recommended remediation phases

## Phase 0 — Release baseline

- **Goal:** riconciliare `main` e `v2.1.5-rc.1`.
- **Why now:** produzione usa codice non presente su `main`.
- **Files:** name store/service, prune tracker, test e changelog.
- **Functions/classes:** `MatterNameStore`, `MatterNameService`, prune cycle tracker.
- **Implementation approach:** port selettivo di reservation e prune guard, senza merge cieco.
- **Tests:** restart, reconnect, device assente, categoria disabilitata, discovery parziale.
- **Risk:** MEDIUM.
- **Compatibility impact:** default invariati.
- **Runtime verification:** inventario 53 invariato, nessuna rinomina inattesa.
- **Rollback:** downgrade senza toccare storage/fabric.
- **Exit criteria:** `verify` verde e diff RC→main spiegato.

## Phase 1 — Command correctness

- **Goal:** distinguere queued/requested, sent, acknowledged, rejected, timeout e state-confirmed.
- **Why now:** è il P0 che condiziona ogni diagnosi Alexa.
- **Files:** command service/dispatcher, protocol router, status updater, error types, handler Matter/HAP/MQTT.
- **Functions/classes:** `sendKseniaCommand`, `registerPendingCommand`, `resolvePendingCommand`, tutti i metodi mutativi.
- **Implementation approach:** mantenere `Promise<void>` pubbliche; usare `CommandOutcome` interno; exact ID prima, fallback solo con un candidato; validare RESULT; per light/dimmer/cover risolvere su ACK o realtime successivo coerente; gate/scenario richiedono ACK e non possono dichiarare state-confirmed.
- **Tests:** OK, FAIL, timeout, CMD_NOT_AVAILABLE, exact/fallback/ambiguous ID, concurrency, cleanup, disconnect, realtime prima/dopo send.
- **Risk:** HIGH per firmware senza ACK gate/scenario.
- **Compatibility impact:** HAP continua a produrre communication failure; MQTT registra rejection; comportamento Matter termostato resta protetto dai retry loop.
- **Runtime verification:** una luce non critica, almeno 20 comandi.
- **Rollback:** solo downgrade plugin.
- **Exit criteria:** nessun `executed` dopo la sola write e zero pending leak.

## Phase 2 — Naming invariants and provenance

- **Goal:** store affidabile e SSOT dei nomi.
- **Why now:** analyzer e override non devono usare dati corrotti o già mutati.
- **Files:** name store/map/sanitizer, discovery service, tipi derivati.
- **Functions/classes:** load/save, `computeMatterNameMap`, `suffixFor`, `applyCustomName`.
- **Implementation approach:** store v2; NFKC; limite code-point-safe; device ID e nomi unici; fallback ripulito e ricontrollato; `ResolvedDeviceNames` derivato.
- **Tests:** duplicate, Unicode, >32, invalid chars, migration, corrupt store, deterministic ordering, HAP/MQTT invariati.
- **Risk:** MEDIUM.
- **Compatibility impact:** nomi validi invariati; solo record invalidi rigenerati.
- **Runtime verification:** diff old/new map prima della pubblicazione.
- **Rollback:** backup v1 e write atomico.
- **Exit criteria:** tutte le entry caricate soddisfano le invarianti.

## Phase 3 — Voice diagnostics

- **Goal:** analyzer deterministico e read-only.
- **Why now:** guida gli override senza rinomina automatica.
- **Files:** nuovi normalizer/analyzer; finalizer/debug export.
- **Functions/classes:** `normalizeVoiceName`, `analyzeMatterVoiceCollisions`.
- **Implementation approach:** NFKC, lowercase it-IT, vista deaccentata, dizionari piccoli; lexical evidence separata da NLU risk; score documentato; summary/hash.
- **Tests:** exact, room, prefix, containment, abbreviation, singular/plural, artificial suffix, scenario intent, truncation, fixture.
- **Risk:** LOW.
- **Compatibility impact:** nessuno.
- **Runtime verification:** hash stabile e niente log flooding.
- **Rollback:** rimuovere l'integrazione diagnostica.
- **Exit criteria:** finding ripetibili e nessuna mutazione.

## Phase 4 — Topology lifecycle

- **Goal:** serializzare rename, prune e recovery.
- **Why now:** le API Homebridge bridged non attendono il completamento materiale.
- **Files:** nuovo coordinator, registry, finalizer, prune e recovery.
- **Functions/classes:** register/unregister, probe queryability, finalizzazione nomi.
- **Implementation approach:** una operazione topologica alla volta; coda/coalescing per device; poll bounded dopo unregister/register; verificare NodeLabel e cluster; rollback allo snapshot precedente.
- **Tests:** stesso ID, ordering, timeout, rollback, restart mid-flight, coalescing, prune durante rename.
- **Risk:** HIGH.
- **Compatibility impact:** identità/fabric invariati; operazioni più lente ma ordinate.
- **Runtime verification:** una rinomina, endpoint count invariato, osservazione warning lock.
- **Rollback:** ripubblicare snapshot precedente.
- **Exit criteria:** `locally-published` verificato; controller ancora `unknown`.

## Phase 5 — Per-device Matter policy

- **Goal:** nome ed esposizione mirati con una SSOT.
- **Why now:** lifecycle pronto a gestire differenze puntuali.
- **Files:** schema, types, resolver, name service e README.
- **Functions/classes:** `resolveMatterPolicy`.
- **Implementation approach:** `matterOverrides` indicizzato per device ID; nessun preset in v1.
- **Tests:** config legacy, categoria, override, precedence, invalid entry, HAP/MQTT invariati.
- **Risk:** MEDIUM.
- **Compatibility impact:** nessuno senza nuova config.
- **Runtime verification:** un override alla volta.
- **Rollback:** rimuovere la singola entry.
- **Exit criteria:** inventario legacy invariato.

## Phase 6 — Explicit thermostat recovery

- **Goal:** eliminare lo sticky fallback senza loop.
- **Why now:** dipende da store v2 e topology coordinator.
- **Files:** fallback store, registry, recovery, schema/types/docs.
- **Functions/classes:** `MatterFallbackStore`, registration recovery.
- **Implementation approach:** strategia B; richiesta amministrativa monotona per device ID, un solo tentativo, stesso ID, verifica cluster, rollback automatico al TemperatureSensor.
- **Tests:** first failure, persisted restart, retry, failure, success, rollback, generation consumed, crash/restart, no boot loop.
- **Risk:** HIGH.
- **Compatibility impact:** zero senza richiesta esplicita.
- **Runtime verification:** un solo termostato.
- **Rollback:** TemperatureSensor automatico.
- **Exit criteria:** Thermostat o fallback localmente queryable, nessuna oscillazione.

# 6. Proposed commits

| Commit | Purpose | Behavioral change | Risk | Dependency |
|---|---|---|---|---|
| `chore(release): reconcile v2.1.5-rc.1 with main` | baseline | nessuno aggiuntivo | LOW | — |
| `fix(matter): preserve reserved name slots` | reservation | riduce name churn | MEDIUM | baseline |
| `fix(matter): reject degenerate prune cycles` | prune guard | evita prune sospetti | MEDIUM | baseline |
| `fix(websocket): validate response outcomes` | RESULT | response negative rigetta | MEDIUM | baseline |
| `fix(websocket): harden pending correlation` | ID/fallback | niente match ambiguo | MEDIUM | RESULT |
| `feat(commands): track acknowledgements and realtime confirmation` | ACK/state | output attendono prova | HIGH | dispatcher |
| `fix(commands): propagate truthful terminal outcomes` | handler/log | niente falso executed | MEDIUM | outcome |
| `fix(matter): validate and migrate persisted names` | store v2 | record invalidi rigenerati | MEDIUM | reservation |
| `refactor(naming): derive resolved device names` | provenance | abilita Matter-only | MEDIUM | store v2 |
| `feat(matter): add read-only voice collision diagnostics` | analyzer | solo diagnostica | LOW | provenance |
| `fix(matter): serialize topology mutations` | coordinator | register/unregister ordinati | HIGH | store v2 |
| `fix(matter): verify local rename publication` | NodeLabel | stato locale reale | HIGH | coordinator |
| `feat(config): add per-device Matter overrides` | policy | opt-in per device ID | MEDIUM | provenance/coordinator |
| `fix(matter): version thermostat fallback records` | store fallback | migrazione esplicita | MEDIUM | store pattern |
| `feat(matter): add explicit thermostat recovery requests` | recovery | un tentativo per generazione | HIGH | coordinator/fallback v2 |

Ogni commit include test dedicati descritti nelle relative fasi e deve superare `npm run verify`.

# 7. Proposed config model

```json
{
  "matterExposure": {
    "zones": false,
    "sensors": false
  },
  "matterOverrides": {
    "light_12": { "name": "Lampadario Studio" },
    "scenario_14": { "exposed": false },
    "sensor_temp_21": {
      "name": "Temperatura Studio",
      "exposed": true
    }
  },
  "matterRecoveryRequests": {
    "thermostat_18": 1
  }
}
```

Precedenza esposizione:

```text
esclusione globale esistente
  > matterOverrides[deviceId].exposed
  > matterExposure[categoria]
  > default corrente true
```

Precedenza nome:

```text
matterOverrides[deviceId].name
  > customNames esistente
  > sourceName Ksenia
  > sanitizzazione/collision resolver
```

`matterRecoveryRequests` è amministrativo e monotono, non parte della policy voice-first.

# 8. Migration strategy

1. Config legacy invariata.
2. Port selettivo RC→main.
3. Lettura v1, validazione e conversione in memoria.
4. Backup v1 prima del primo write v2.
5. Write atomico.
6. Record invalidi esclusi singolarmente; mai cancellare tutto lo store.
7. Duplicate seed risolto deterministicamente.
8. Nomi validi preservati byte-for-byte.
9. Fallback legacy migrato con reason `legacy-unknown`.
10. Nessun marker avvia automaticamente una recovery.
11. Recovery generation persistita in modo restart-safe.
12. Nessuna migrazione tocca UUID, fabric, bridge, HAP o MQTT.

# 9. Production canary plan

1. **Baseline:** sette giorni di log, inventario e nomi fotografati, store copiati.
2. **Command:** una luce non critica, 20+ comandi in 24 ore; rollback sopra 5% errori o pending leak.
3. **Analyzer:** un boot e un restart; successo se hash stabile e nessun flooding.
4. **Rename:** una sola luce omonima a stanza; controlli 0/5/15/60 minuti e 24 ore.
5. **Prune:** un solo scenario non critico; nessuna categoria intera.
6. **Gate:** solo dopo ACK; stop se il protocollo non conferma.
7. **Thermostat:** un solo device ID; rollback automatico al primo fallimento.

Ogni canary misura baseline, change, expected result, observation period, rollback condition e success condition prima di passare al successivo.

# 10. Alexa live validation plan

Per ogni prova: frase, trascrizione, risposta Alexa, endpoint scelto, azione fisica, command ID e outcome plugin.

- tap app vs stessa azione a voce;
- `accendi Studio` vs `accendi Lampadario Studio`;
- vecchio e nuovo nome dopo rename;
- `chiudi Finestra Studio`;
- `accendi Cancello`, `apri Cancello`, `accendi Apri Cancello`;
- `apri Cancello Grande`;
- query temperatura;
- stesso endpoint da Siri e Alexa;
- inventario dopo un singolo prune.

`Spegni Tutto` non è un test ordinario. `controller-observed` viene registrato solo nel verbale manuale.

# 11. Release plan

## 2.1.5 — baseline e correctness

- `2.1.5-rc.2`: riconciliazione RC/main, reservation, prune guard.
- `2.1.5-rc.3`: response validation, ID, outcome diagnostico.
- `2.1.5-rc.4`: ACK-or-realtime e propagazione veritiera.
- Soak 7–14 giorni e almeno 100 comandi prima di `2.1.5` stable.

## 2.2.0 — capacità additive

- `2.2.0-rc.1`: store v2, provenance, analyzer.
- `2.2.0-rc.2`: topology coordinator e rename.
- `2.2.0-rc.3`: `matterOverrides`.
- `2.2.0-rc.4`: fallback v2 e recovery esplicita.
- Soak finale minimo 14 giorni prima di `2.2.0` stable.

Ogni RC deve superare Node 20/22/24, `npm run verify` e `npm audit --omit=dev`.

# 12. Deferred work

- Retry termostati automatico.
- Bridge Matter voice-first separato.
- Custom Alexa Smart Home Skill.
- Cataloghi differenti per controller sullo stesso node.
- Generic Switch per gate/scenari.
- Modelli fonetici, ML o NLP esterni.
- Rinomina automatica.
- Persistenza output type senza prova runtime.
- Stato fisico gate/scenario senza evento protocollo.
- Preset globale voice-first.
- Metriche ad alta cardinalità.

# 13. Things we must not do

- Cambiare device ID o UUID.
- Resettare Matter storage, fabric o commissioning.
- Disinstallare/reinstallare come remediation ordinaria.
- Cancellare name map o fallback store.
- Fare unregister/register massivo a ogni boot.
- Trattare `sent == acknowledged`.
- Trattare `locally-published == controller-observed`.
- Correlare response ambigue.
- Inventare conferma fisica gate/scenario.
- Mutare il nome HAP/MQTT da un override Matter.
- Cambiare default di esposizione.
- Rinominare automaticamente le entità.
- Mescolare command ACK, topology e thermostat recovery nella stessa RC.
- Loggare PIN, token, QR/setup code o credenziali.

# 14. Final recommendation

1. Riconciliare `main` con la RC installata.
2. Correggere il command path come P0, incluso `dimLight`.
3. Usare ACK o realtime per gli output osservabili.
4. Non inventare conferme per gate/scenari.
5. Versionare gli store prima di estenderli.
6. Derivare i nomi lasciando HAP/MQTT invariati.
7. Introdurre l'analyzer solo read-only.
8. Serializzare ogni mutazione topologica.
9. Aggiungere poi override per device ID.
10. Recuperare un solo termostato esplicitamente.
11. Conservare identity, fabric e commissioning.
12. Rilasciare correctness in 2.1.5 e feature additive in 2.2.0.
13. Usare un canary separato per ogni modifica HIGH.
14. Lasciare `controller-observed` unknown senza test Alexa.
