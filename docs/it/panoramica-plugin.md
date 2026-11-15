# Panoramica del Plugin

## Componenti Runtime

- `Lares4Platform`: orchestratore della piattaforma Homebridge (`src/platform/index.ts`).
- `KseniaWebSocketClient`: facade WebSocket, l'unico modulo che parla con la centrale (`src/websocket-client/index.ts`).
- `MqttBridge`: bridge opzionale di pubblicazione e comandi MQTT (`src/mqtt-bridge/index.ts`).
- Handler degli accessori: adattatori HomeKit in `src/accessories/*`.
- Sottosistema Matter: registro, coordinatore della topologia, servizio dei nomi e handler dei termostati in `src/platform/matter-*`.
- `DebugCaptureManager`: cattura del traffico grezzo con redazione dei dati sensibili (`src/debug-capture/index.ts`).

La mappa dei moduli e i confini tra i livelli sono in [`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Avvio e Sincronizzazione

1. Homebridge chiama `didFinishLaunching`. La configurazione viene validata una sola volta: i tipi sbagliati e i numeri fuori intervallo vengono corretti e segnalati in un unico warning (vedi [Configurazione e UI](./configurazione-e-ui.md)).
2. Se abilitato, l'import KSA viene eseguito prima della connessione.
3. Il plugin apre il WebSocket (sottoprotocollo `KS_WSOCK`) ed esegue il login.
4. **Ogni login è una sincronizzazione a sé**: letture di discovery (zone, output, scenari, sensori DOMUS), letture di stato, letture dei termostati, poi la registrazione realtime. Vedi [Protocollo WebSocket](./protocollo-websocket.md).
5. La sincronizzazione è completa solo quando la centrale ha accettato la registrazione realtime. A quel punto le mappe dei nomi HomeKit e Matter vengono finalizzate e gli accessori obsoleti vengono rimossi.
6. Le variazioni realtime (`STATUS_*`) diventano autorevoli. Una riconnessione avvia una nuova sincronizzazione.

Il log stampa un riepilogo dei dispositivi scoperti con i loro ID, e lo ripete solo quando l'elenco dei dispositivi cambia.

## Modello dei Dispositivi

Output e scenari vengono classificati prima che venga esposto qualsiasi cosa. Ciò che il plugin non riconosce **non viene esposto** (politica fail-closed):

- Output: `LIGHT` diventa `light_*`, `ROLL` diventa `cover_*`, `GATE` con modalità `M` diventa `gate_*` (altre modalità: `cover_*`), le categorie dei termostati diventano `thermostat_*`. Qualsiasi altro output (`GEN`, `IRR`, senza categoria) è nascosto, a meno che sia elencato in `exposeOutputs`, che lo espone come `light_*`.
- Le zone diventano `zone_*`.
- Gli scenari diventano `scenario_*` quando la centrale li elenca come `GEN`. `ARM` e `DISARM` non vengono mai esposti; `PARTIAL` solo con `exposePartialArmScenarios`; le categorie sconosciute o mancanti solo tramite `exposeScenarios`.
- I sensori del bus DOMUS diventano `sensor_temp_*`, `sensor_hum_*` e `sensor_light_*`; le temperature proprie della centrale sono `sensor_system_temp_in` e `sensor_system_temp_out`.

Un dispositivo nascosto o escluso viene rimosso da HomeKit alla prima sincronizzazione e da Matter dopo tre sincronizzazioni complete, non viene pubblicato su MQTT e non può essere comandato.

## Principi Fondamentali

- Il realtime (`STATUS_*`) è preferito alle assunzioni statiche.
- Un comando è `requested`, `sent`, poi `acknowledged` (`RESULT=OK`) oppure `state-confirmed` (l'output è davvero cambiato). Una scrittura sul socket non è mai un successo.
- Le scritture dei termostati inviano solo ciò che il comando modifica (`WRITE_CFG`), mai l'intera configurazione letta al login.
- L'instradamento dei comandi dei termostati è esplicito e fail-closed: se non si riesce a stabilire qual è il termostato giusto della centrale, la scrittura viene rifiutata.
- La telemetria delle stanze DOMUS e l'instradamento dei comandi dei termostati sono questioni separate.
- La topologia Matter è decisa da ciò che il plugin osserva, non dal valore di ritorno di una chiamata di registrazione.

## Fonti Dati

- `MULTI_TYPES`: output, scenari e sensori DOMUS (discovery).
- `ZONES`: zone (discovery).
- `STATUS_OUTPUTS`, `STATUS_ZONES`, `STATUS_BUS_HA_SENSORS`: stato runtime.
- `STATUS_SYSTEM`: le temperature proprie della centrale.
- `CFG_THERMOSTATS`: configurazione persistente dei termostati, riletta prima di una scrittura del setpoint.
- `STATUS_TEMPERATURES`: stato realtime dei termostati, indicizzato per ID del sensore DOMUS.
- `PRG_THERMOSTATS` (quando il firmware lo prevede): mappatura strutturale tra output, ID del termostato, sensore DOMUS e ruolo di riscaldamento/raffrescamento.

## Riepilogo Integrazione KSA

- `ksaImport` può analizzare un backup `.ksa` e ricavarne la mappatura dei comandi dei termostati (`output -> cfg thermostat ID`), la mappatura dei sensori DOMUS (`output -> sensor ID`), la mappatura delle stanze e i nomi personalizzati opzionali.
- Il file `.ksa` è trattato come input non attendibile (solo ID numerici, nomi tagliati a 64 caratteri, al massimo 32 MB).
- Una cache sanitizzata viene scritta nella cartella di storage di Homebridge (`klares4-ksa-cache.json`). Il runtime può precaricare la mappatura da essa anche se `PRG_THERMOSTATS` non è disponibile sul firmware. Non viene salvato nessun payload `.ksa` grezzo.

## File Scritti dal Plugin

Tutti nella cartella di storage di Homebridge. I file creati per la prima volta sono privati (`0600`).

| File | Contenuto |
|---|---|
| `klares4-devices.json` | I dispositivi scoperti con i loro ID |
| `klares4-room-mapping-example.json` | Un blocco `roomMapping` di esempio; scritto alla prima sincronizzazione e quando l'elenco dei dispositivi cambia |
| `klares4-ksa-cache.json` | Dati sanitizzati ricavati dal backup `.ksa` |
| `klares4-matter-names.json` | I nomi Matter calcolati (versione 2). I nomi dei dispositivi ancora presenti sulla centrale non scadono mai; il nome di un dispositivo scomparso viene riservato per 30 giorni |
| `klares4-matter-fallback.json` | I termostati che sono ripiegati su un sensore di temperatura e la revisione del payload Thermostat dell'ultimo tentativo nativo |
| `klares4-matter-prune.json` | I contatori di assenze consecutive della potatura Matter |
| `klares4-debug-<timestamp>.json` | Il file di debug (riservato), solo quando `generateDebugFile` è attivo |

`config.json` viene modificato solo dall'interruttore del file di debug e da un `applyAtStartup` esplicito dell'import KSA. Un link simbolico resta un link; se il file non può essere sostituito in modo atomico (bind mount Docker di un singolo file, `EBUSY`) il plugin lo riscrive sul posto e registra un warning.
