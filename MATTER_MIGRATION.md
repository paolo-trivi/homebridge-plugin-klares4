# Piano di Migrazione: Homebridge 2.0 & Matter — `homebridge-plugin-klares4`

## Contesto

Homebridge 2.0 introduce un layer Matter che valida gli accessori **immediatamente all'avvio**, prima che WebSocket/MQTT verso la centrale Ksenia Lares4 si connetta. Nel codice attuale:

- [src/platform/accessory-registry.ts:30-33](Sviluppo/homebridge-plugin-klares4/src/platform/accessory-registry.ts#L30-L33) — `configureAccessory` salva l'accessorio in mappa ma **non istanzia l'handler**. L'handler viene creato solo dentro `addAccessory`, che gira al primo ciclo di discovery (dopo connessione WS).
- Risultato in HB 1.x: tollerato — HomeKit attende.
- Risultato in HB 2.0 + Matter: il bridge Matter ispeziona l'accessorio prima che `addAccessory` sia stato chiamato, non trova `onGet/onSet` registrati e **scarta silenziosamente** l'accessorio dalla rete Matter.

Inoltre alcuni `onGet` (es. `ThermostatAccessory.getCurrentTemperature` a [src/accessories/thermostat-accessory.ts:115](Sviluppo/homebridge-plugin-klares4/src/accessories/thermostat-accessory.ts#L115)) restituiscono `0` come fallback, valore che è valido per `CurrentTemperature` (-270..100) ma sarebbe fuori bounds se applicato a `TargetTemperature` (impostata 10..38 a [riga 72-76](Sviluppo/homebridge-plugin-klares4/src/accessories/thermostat-accessory.ts#L72-L76)).

Obiettivo: rendere il plugin **100% compatibile Matter** mantenendo retro-compatibilità con HB 1.x, senza introdurre dipendenze Matter dirette (Homebridge espone gli accessori a Matter automaticamente).

---

## Stato Attuale Validato

| Area | Stato | Note |
|---|---|---|
| `engines.homebridge` | `^1.6.0 \|\| ^2.0.0-beta.0` | Già aperto a 2.0 |
| `devDependencies.homebridge` | `^1.11.1` | Va aggiornato per test contro 2.0 |
| `@types/node` | `^20.0.0` | OK per Node 20; salire a `^22` opzionale |
| `createAccessoryHandler` callback | ✅ presente in [accessory-registry.ts:13-16](Sviluppo/homebridge-plugin-klares4/src/platform/accessory-registry.ts#L13-L16) | Pronto per essere chiamato da `configureAccessory` |
| `accessory.context.device` su cache | ✅ persistito a [riga 42, 57, 81](Sviluppo/homebridge-plugin-klares4/src/platform/accessory-registry.ts#L42) | Disponibile in `configureAccessory` al restore |
| `HapStatusError` su errori `onSet` | ✅ già conforme | Tutti gli accessori (light, cover, thermostat, gate, scenario) |
| `AccessoryInformation` (Manufacturer/Model/Serial/Firmware) | ✅ impostati in ogni costruttore | `SerialNumber = device.id` senza validazione vuoto |
| `getCurrentTemperature` fallback | ⚠️ ritorna `0` se undefined | Accettabile per HAP, ma loggare e usare ultimo noto è più Matter-friendly |
| `FirmwareRevision` | ⚠️ hardcoded `'2.0.1-beta0'` | Va allineato a `package.json.version` |
| Child Bridge | Non configurato | Raccomandato (non obbligatorio) per Matter |

---

## Modifiche da Applicare

### 1. `package.json` — dipendenze di sviluppo

[package.json](Sviluppo/homebridge-plugin-klares4/package.json)

- `engines.homebridge`: lasciare `"^1.6.0 || ^2.0.0-beta.0"` (già corretto). Quando HB 2.0 stable esce, stringere a `"^1.8.0 || ^2.0.0"`.
- `devDependencies.homebridge`: aggiornare a `"^2.0.0-beta.0"` per type-check contro le API 2.0.
- `devDependencies.@types/node`: aggiornare a `"^22.0.0"` (allineato a Node 20 LTS + 22).
- Nessuna nuova `dependencies` runtime necessaria — Homebridge gestisce Matter internamente.

### 2. `src/platform/accessory-registry.ts` — istanziare handler dalla cache

[src/platform/accessory-registry.ts:30-33](Sviluppo/homebridge-plugin-klares4/src/platform/accessory-registry.ts#L30-L33)

Modificare `configureAccessory` per istanziare immediatamente l'handler dal `context.device` cached, **prima** che il discovery WS produca dati freschi. Aggiungere check di validità:

```typescript
public configureAccessory(accessory: PlatformAccessory): void {
    this.options.log.info('Loading accessory from cache:', accessory.displayName);
    this.options.accessories.set(accessory.UUID, accessory);

    // Matter-readiness: handler must be live before the bridge inspects the accessory.
    const device = accessory.context?.device as KseniaDevice | undefined;
    if (!device || !device.id) {
        this.options.log.warn(
            `Skipping cache handler init for ${accessory.displayName}: missing device context`,
        );
        return;
    }

    const handler = this.options.createAccessoryHandler(accessory, device);
    if (handler) {
        this.options.accessoryHandlers.set(accessory.UUID, handler);
        this.options.log.debug(`Handler attached from cache for ${device.name}`);
    }
}
```

E in `addAccessory` (riga 40-52) il ramo "exising accessory + no handler" diventa raro ma resta come safety-net (nessuna modifica).

### 3. Validazione di `device.id` non-vuoto (SerialNumber)

In ciascun costruttore di accessorio (light, cover, gate, sensor, zone, thermostat, scenario), prima di impostare `SerialNumber`, garantire fallback non-vuoto:

```typescript
const serial = this.device.id && this.device.id.length > 0
    ? this.device.id
    : `lares4-${accessory.UUID.slice(0, 8)}`;
accessoryInfoService.setCharacteristic(
    this.platform.Characteristic.SerialNumber,
    serial,
);
```

File interessati:
- [src/accessories/light-accessory.ts:26](Sviluppo/homebridge-plugin-klares4/src/accessories/light-accessory.ts#L26)
- [src/accessories/cover-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/cover-accessory.ts)
- [src/accessories/gate-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/gate-accessory.ts)
- [src/accessories/sensor-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/sensor-accessory.ts)
- [src/accessories/zone-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/zone-accessory.ts)
- [src/accessories/thermostat-accessory.ts:33](Sviluppo/homebridge-plugin-klares4/src/accessories/thermostat-accessory.ts#L33)
- [src/accessories/scenario-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/scenario-accessory.ts)

### 4. `FirmwareRevision` allineato automaticamente a `package.json.version`

Obiettivo: ogni bump di versione (manuale, `npm version`, o release CI) aggiorna **da solo** la `FirmwareRevision` esposta a HomeKit/Matter, **senza** modifiche al codice TypeScript.

#### 4.1 Creare modulo `src/plugin-version.ts` (NUOVO)

```typescript
// src/plugin-version.ts
// Auto-sync con package.json — non modificare manualmente la stringa.
import { version as RAW_VERSION } from '../package.json';

/**
 * FirmwareRevision conforme HAP/Matter: solo MAJOR.MINOR.PATCH.
 * Matter rifiuta suffissi tipo `-beta0`, `-rc1`, `+build`.
 * Es: "2.1.0-beta0" → "2.1.0", "2.1.0" → "2.1.0".
 */
export const PLUGIN_VERSION: string = RAW_VERSION.split(/[-+]/)[0];

/** Versione raw (con eventuali suffissi) per logging. */
export const PLUGIN_VERSION_RAW: string = RAW_VERSION;
```

#### 4.2 `tsconfig.json` — abilitare import JSON

Verificare/aggiungere:
```jsonc
{
  "compilerOptions": {
    "resolveJsonModule": true,
    "esModuleInterop": true
    // ... resto invariato
  }
}
```

#### 4.3 `package.json` — includere il file nel bundle pubblicato

Il campo `files` è già:
```json
"files": ["dist", "config.schema.json", "README.md", "CHANGELOG.md", "LICENSE"]
```

`package.json` **non** è nell'array, ma viene **sempre** incluso da npm automaticamente. Tuttavia con `resolveJsonModule`, TypeScript copia il riferimento dentro `dist/plugin-version.js` come `require("../package.json")` (path relativo da `dist/`). Verificare con:

```bash
npm run build
node -e "console.log(require('./dist/plugin-version').PLUGIN_VERSION)"
# atteso: "2.0.1"
```

Se il path risolto da `dist/plugin-version.js` punta a `../package.json` (cioè la root del pacchetto pubblicato), funziona out-of-the-box perché `package.json` è sempre presente. **Nessuna modifica al campo `files`**.

#### 4.4 Usare `PLUGIN_VERSION` in tutti gli accessori

Sostituire `'2.0.1-beta0'` hardcoded in 7 file:

```typescript
import { PLUGIN_VERSION } from '../plugin-version';
// ...
accessoryInfoService.setCharacteristic(
    this.platform.Characteristic.FirmwareRevision,
    PLUGIN_VERSION,
);
```

File: [light-accessory.ts:27](Sviluppo/homebridge-plugin-klares4/src/accessories/light-accessory.ts#L27), [cover-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/cover-accessory.ts), [gate-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/gate-accessory.ts), [sensor-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/sensor-accessory.ts), [zone-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/zone-accessory.ts), [thermostat-accessory.ts:34](Sviluppo/homebridge-plugin-klares4/src/accessories/thermostat-accessory.ts#L34), [scenario-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/scenario-accessory.ts).

#### 4.5 Guard di regressione (test)

Aggiungere `test/plugin-version.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { PLUGIN_VERSION, PLUGIN_VERSION_RAW } = require('../dist/plugin-version');
const pkg = require('../package.json');

test('PLUGIN_VERSION_RAW matches package.json version exactly', () => {
    assert.strictEqual(PLUGIN_VERSION_RAW, pkg.version);
});

test('PLUGIN_VERSION is HAP/Matter-compliant semver (M.m.p, no suffix)', () => {
    assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/);
});
```

Così se qualcuno bumpa `package.json` a una forma non-semver-strict, il test fallisce in CI.

#### 4.6 Effetto

| Scenario | Prima | Dopo |
|---|---|---|
| `npm version patch` → `2.0.2` | resta `2.0.1-beta0` (bug) | diventa `2.0.2` automaticamente |
| `npm version prerelease` → `2.1.0-beta0` | resta `2.0.1-beta0` | diventa `2.1.0` (suffisso strippato) |
| Pubblicazione su npm | FW disallineato a versione pacchetto | FW sempre allineato |

### 5. `ThermostatAccessory` — bounds e stato iniziale Matter-safe

[src/accessories/thermostat-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/thermostat-accessory.ts)

- **`getCurrentTemperature`** (riga 108-117): ritornare l'ultimo valore noto memorizzato in `accessory.context` invece di `0`. `0` è formalmente nei bounds (-270..100) ma confonde Matter e l'app Casa mostra "0°C" all'avvio. Soluzione: persistere `lastKnownTemp` in `accessory.context` e usarlo come fallback; default finale `21`.

- **`getTargetTemperature`** (riga 119-132): già corretto (usa `temperatureDefaults.target ?? 21`). Verificare che `21` rientri nei bounds `[temperatureDefaults.min, temperatureDefaults.max]` — se l'utente configura `min: 25`, il default 21 sarebbe fuori range. Aggiungere clamp:
  ```typescript
  const min = tempDefaults.min ?? 10;
  const max = tempDefaults.max ?? 38;
  const defaultTemp = Math.max(min, Math.min(max, tempDefaults.target ?? 21));
  ```

- **Persistere ultimi valori noti**: in `updateStatus` (riga 208) scrivere `this.accessory.context.lastKnownTemp = newDevice.currentTemperature` così al restart il fallback è realistico.

### 6. Caratteristica `Name` esplicita

Tutti i costruttori chiamano `.setCharacteristic(Name, this.device.name)` su `Lightbulb`/`Thermostat`/etc. — OK. Verificare che `device.name` sia sempre non vuoto in [src/types](Sviluppo/homebridge-plugin-klares4/src/types); aggiungere fallback `device.name || 'Lares4 Device'` per non far rifiutare la registrazione Matter.

### 7. `onGet` non deve mai rigettare la Promise per problemi di rete

Validato: tutti gli `onGet` attuali sono effettivamente sincroni dietro `async` (leggono `this.device.status.*`). **Nessuna modifica necessaria**, ma aggiungere commento di policy in [src/accessories/light-accessory.ts](Sviluppo/homebridge-plugin-klares4/src/accessories/light-accessory.ts) (o documentare in `CLAUDE.md`/`README`): mai fare I/O di rete in `onGet`. Solo `onSet` può lanciare `HapStatusError(SERVICE_COMMUNICATION_FAILURE)`.

### 8. Pulizia handler su `removeAccessory`

[src/platform/accessory-registry.ts:93-107](Sviluppo/homebridge-plugin-klares4/src/platform/accessory-registry.ts#L93-L107) — già gestisce `dispose()`. Verificare che ogni handler esponga `dispose()` se sottoscrive a eventi WS (audit veloce su `light/cover/thermostat/gate/sensor/zone/scenario` — al momento nessuno lo fa esplicitamente; OK perché le sottoscrizioni vivono sul `wsClient` della platform).

---

## File Modificati (Riepilogo)

| File | Tipo modifica |
|---|---|
| `package.json` | bump devDeps homebridge → 2.0-beta, @types/node → 22 |
| `tsconfig.json` | abilitare `resolveJsonModule` se assente |
| `src/platform/accessory-registry.ts` | eager handler init in `configureAccessory` |
| `src/platform/plugin-version.ts` (NUOVO) | export `PLUGIN_VERSION` da package.json |
| `src/accessories/light-accessory.ts` | serial guard + FW dinamica |
| `src/accessories/cover-accessory.ts` | serial guard + FW dinamica |
| `src/accessories/gate-accessory.ts` | serial guard + FW dinamica |
| `src/accessories/sensor-accessory.ts` | serial guard + FW dinamica |
| `src/accessories/zone-accessory.ts` | serial guard + FW dinamica |
| `src/accessories/thermostat-accessory.ts` | serial guard + FW dinamica + clamp default + persist lastKnownTemp |
| `src/accessories/scenario-accessory.ts` | serial guard + FW dinamica |

---

## Verifica End-to-End

1. **Build & type-check**
   ```bash
   npm install
   npm run verify   # max-lines + tsc --noEmit --noUnusedLocals + tests
   ```

2. **Test unitari**
   ```bash
   npm test
   ```
   Aggiungere un test in `test/` che simuli `configureAccessory` con un `PlatformAccessory` mock contenente `context.device` valido e verifichi che `accessoryHandlers.get(uuid)` non sia `undefined` subito dopo.

3. **Smoke test in Homebridge 2.0**
   - Installare HB 2.0-beta in un'istanza di test:
     ```bash
     npm install -g homebridge@beta
     ```
   - `npm link` il plugin nella directory di Homebridge.
   - Avviare con `homebridge -D` e verificare nei log:
     - `Loading accessory from cache: <name>` seguito da `Handler attached from cache for <name>` — **prima** della connessione WS.
   - Nessun warning Matter del tipo `accessory missing characteristic handler`.

4. **Test Matter pairing**
   - In Homebridge UI → Plugin → klares4 → Bridge Settings → abilitare **Child Bridge**.
   - Riavviare. Aprire la sezione Accessori: deve apparire QR code Matter dedicato al child bridge.
   - In iOS app Casa → Aggiungi Accessorio → scansionare QR → tutti i dispositivi Lares4 (luci, tapparelle, termostati, sensori, scenari) devono apparire entro 30s.
   - Toggle di una luce dall'app Casa → verifica nei log del plugin che `setOn` venga invocato e il comando WS parta.

5. **Test cold-start (Matter timing)**
   - Spegnere la centrale Ksenia (WS offline).
   - Riavviare Homebridge.
   - L'app Casa deve comunque mostrare gli accessori (con stato cached). Nessuno deve apparire "Non risponde" entro i primi 10s.
   - Riaccendere la centrale → stati si aggiornano via `updateStatus`.

6. **Regression HB 1.x**
   - Ripetere smoke test con `homebridge@1.11`. Tutto deve continuare a funzionare (la modifica a `configureAccessory` è una pura anticipazione, non cambia il contratto).

---

## Note Operative

- **Non** introdurre dipendenze a `@matter/main` o `node-matter`: Homebridge 2.0 espone gli accessori HAP a Matter automaticamente via il bridge interno. Il plugin resta un normale dynamic platform plugin.
- **Child Bridge raccomandato**: isolare il plugin in un proprio processo riduce l'impatto di un crash WS sul resto di Homebridge ed è la configurazione testata da Apple per Matter pairing.
- **Versioning**: dopo il merge, bump a `2.1.0` (minor — compatibilità Matter è una feature, non breaking).
