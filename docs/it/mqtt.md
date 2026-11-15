# Bridge MQTT

Il bridge pubblica lo stato di ogni dispositivo esposto, pubblica la propria disponibilità e (a meno che tu non lo disattivi) riceve comandi. È opzionale e disattivato per impostazione predefinita (`mqtt.enabled`).

## Configurazione

| Chiave | Note |
|---|---|
| `mqtt.enabled` | Attiva il bridge |
| `mqtt.commands` | Predefinito `true`. `false`: il bridge non si sottoscrive mai ai topic `.../set`, quindi nulla di ciò che viene pubblicato sul broker può azionare un dispositivo |
| `mqtt.broker` | URL con schema: `mqtt://`, `mqtts://`, `ws://`, `wss://` (funzionano anche `tcp://`, `tls://`, `ssl://`). Un URL che mqtt.js leggerebbe come un altro host (senza schema, `mqtt:/host`, un `/` o `#` non escapati nella password) viene rifiutato con un errore invece di connettersi altrove |
| `mqtt.port` | Sovrascrive la porta dell'URL. Vuoto: la porta dell'URL, oppure quella predefinita del protocollo (1883, 8883) |
| `mqtt.username`, `mqtt.password` | Da preferire alle credenziali nell'URL, che hanno la precedenza quando sono impostati entrambi. Una password con `/`, `#`, `?` o `@` deve essere codificata in percent-encoding nell'URL |
| `mqtt.clientId` | Univoco per ogni istanza di Homebridge sullo stesso broker; vuoto per uno casuale |
| `mqtt.topicPrefix` | Predefinito `homebridge/klares4`; non può contenere `+` o `#` (rifiutato all'avvio) |
| `mqtt.qos` | 0, 1 (predefinito) o 2 |
| `mqtt.retain` | Predefinito `true`, per i topic di stato |

Il log mostra il broker solo come `scheme://host:port`, senza utente né password.

## Topic

| Topic | Direzione | Contenuto |
|---|---|---|
| `<prefix>/<type>/<slug>/state` | plugin → broker | Stato retained di un dispositivo |
| `<prefix>/<room>/<type>/<slug>/state` | plugin → broker | Lo stesso con `roomMapping` attivo |
| `<prefix>/<type>/<id or slug>/set` | broker → plugin | Comandi (solo con `mqtt.commands` attivo) |
| `<prefix>/<room>/<type>/<id>/set` | broker → plugin | Lo stesso con `roomMapping` attivo: eseguito solo se il dispositivo appartiene a quella stanza |
| `<prefix>/status` | plugin → broker | Disponibilità, sempre retained |

- `<type>` è `light`, `cover`, `thermostat`, `sensor`, `zone` o `scenario`. I dispositivi senza stanza (le temperature della centrale stessa) usano il topic senza stanza.
- Lo slug è ricavato dal nome del dispositivo. Due dispositivi che producono lo stesso slug (`Bathroom Light` e `bathroom light`), o un nome senza lettere né cifre, vengono pubblicati ciascuno con il proprio ID dispositivo (`.../light/light_6/state`) con un warning; il topic retained condiviso viene cancellato. I dispositivi che non collidono mantengono il loro topic. I consumatori che leggono per nome un dispositivo in collisione devono passare al topic con l'ID (oppure dare ai dispositivi nomi distinti).
- I nomi delle stanze che contengono `+`, `#` o `/` vengono pubblicati con `_` al loro posto.
- I dispositivi esclusi con le liste `exclude*` o nascosti dalla politica di esposizione non vengono pubblicati (i topic retained lasciati dalle versioni precedenti non vengono cancellati: eliminali sul broker).
- I filtri `+/+/state` e `+/+/+/state` usati dai consumatori di stato non corrispondono a `<prefix>/status`.

## Payload di Stato

Ogni payload contiene `id`, `name`, `type` e un `timestamp` ISO, più:

| Tipo | Campi |
|---|---|
| light | `on`, `brightness` (0-100), `dimmable` |
| cover | `position` (0-100), `state` (`opening`, `closing`, `stopped`) |
| thermostat | `currentTemperature`, `targetTemperature`, `mode` (`off`, `heat`, `cool`, `auto`), `humidity` quando nota |
| sensor | `sensorType`, `value`, `unit` |
| zone | `open`, `armed`, `fault`, `bypassed` |
| scenario | `active` |

Un cancello pubblica la forma generica `{"active": false}`, che non è uno stato reale. Il flag di manomissione di una zona è mostrato solo su HomeKit.

## Disponibilità: `<prefix>/status`

Retained, QoS `mqtt.qos`, qualunque cosa dica `mqtt.retain`.

- Mentre il bridge è in esecuzione: `{"state":"online","panel":"connected","timestamp":"<ISO time>"}`, dove `panel` è `connected`, `disconnected` o `unknown` (la connessione alla centrale come la vede la piattaforma; `unknown` solo se il bridge viene usato senza la piattaforma). Una centrale offline fin dall'avvio risulta `disconnected` dal primo messaggio.
- Quando il bridge non c'è più: `{"state":"offline"}`. Viene pubblicato a uno spegnimento pulito ed è registrato come **last will** MQTT, quindi il broker lo pubblica dopo un crash o una perdita di rete (dopo il keep-alive, 60 secondi).

Home Assistant:

```yaml
availability_topic: homebridge/klares4/status
availability_template: "{{ value_json.state }}"
payload_available: online
```

## Comandi

Pubblica con `retain=false`: un comando retained viene ignorato con un warning (il broker lo riproporrebbe a ogni riconnessione); cancellalo con un messaggio retained vuoto su quel topic. I payload sono oggetti JSON di al massimo 4 KB; le chiavi extra sconosciute vengono ignorate.

| Dispositivo | Payload |
|---|---|
| Light | `{"on": true, "brightness": 80}`; `brightness` solo su una luce dimmerabile; `{"on": false, "brightness": 80}` viene rifiutato; i due passaggi di `{"on": true, "brightness": 40}` vengono eseguiti uno dopo l'altro |
| Cover | `{"position": 50}` (0-100) |
| Thermostat | `{"mode": "off\|heat\|cool\|auto", "targetTemperature": 22}`; un setpoint fuori da `temperatureDefaults.min`/`max` viene rifiutato con un warning |
| Scenario | `{"active": true}` |

- Per ogni dispositivo un comando è in esecuzione e solo il più recente attende; i comandi in attesa più vecchi vengono scartati, con un warning per ogni raffica.
- I comandi non validi vengono rifiutati con un warning che dice cosa ci si aspetta (array, oggetti senza una chiave nota come `{"state":"ON"}` o `{}`, testo che non è JSON, `brightness` su una luce non dimmerabile). Questi warning sono soggetti a limitazione di frequenza. I payload più grandi di 4 KB vengono scartati senza essere analizzati.
- Una ritrasmissione QoS 1 dello stesso comando (flag DUP, stesso ID di pacchetto) non viene eseguita due volte.
- Un comando che la coda della centrale o la validazione rifiutano (dispositivo non ancora scoperto, valore fuori intervallo, uno scenario di inserimento) viene registrato nel log come warning leggibile.
- I livelli del topic e i payload scritti nel log sono tra virgolette e troncati a 80 caratteri.

```bash
mosquitto_pub -h 192.168.1.100 -u mqtt_user -P mqtt_password -t "homebridge/klares4/light/light_1/set" -m '{"on": true, "brightness": 80}'
```

## Comportamento della Connessione

- Nulla viene accodato mentre il broker è irraggiungibile; l'ultimo stato di ogni dispositivo viene ripubblicato alla riconnessione.
- Dopo una connessione rifiutata (password errata, utente non ancora creato, broker in riavvio) il bridge continua a riprovare: dopo 5 s, con backoff fino a ogni 60 s. mqtt.js di per sé non si riconnette (`reconnectPeriod: 0`); i tentativi sono pianificati dal plugin.
- Un broker non raggiungibile produce un errore e un warning quando diventa irraggiungibile, una nuova riga solo se l'errore cambia, e una riga quando si riconnette.
- Quando un dispositivo viene rinominato mentre il plugin è in esecuzione, il vecchio topic di stato retained viene cancellato. I topic rimasti da prima di un riavvio non sono noti al plugin.

## Sicurezza

**Il plugin non autentica i comandi.** Chiunque possa pubblicare su un topic `.../set` può azionare luci, tapparelle, termostati e scenari, e il PIN che hai salvato fa il resto.

1. Usa un broker che richieda l'autenticazione, una ACL che limiti chi può scrivere sui topic `.../set` e TLS (`mqtts://`) quando il broker non è sullo stesso host. Non esiste un'opzione per una CA personalizzata né per saltare la verifica su `mqtts://`: un broker con certificato autofirmato non può essere usato.
2. Se ti serve solo lo stato, imposta `mqtt.commands` su `false`.
3. Con `roomMapping` attivo, confina ogni client a una stanza con una ACL su `<prefix>/<room>/+/+/set`.

Esempio di ACL Mosquitto, solo stato:

```
user klares4
topic write homebridge/klares4/+/+/state
topic write homebridge/klares4/+/+/+/state
topic write homebridge/klares4/status

user reader
topic read homebridge/klares4/#
```

Con i comandi attivi, aggiungi `topic read` per `homebridge/klares4/+/+/set` e `homebridge/klares4/+/+/+/set` per l'utente del plugin, e `topic write homebridge/klares4/<room>/+/+/set` per ogni client che può comandare quella stanza.

**L'utente del plugin deve poter scrivere su `<prefix>/status`.** Mosquitto 2 può rifiutare un CONNECT il cui topic last will l'utente non può scrivere (`Not authorized`). Il bridge allora si riconnette senza last will, scrive nel log un warning che spiega la riga ACL da aggiungere e continua a pubblicare lo stato; si perde solo il rilevamento dei crash.
