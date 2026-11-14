# A — Fail-closed exposure (WS-01 / PLAT-05, WS-02 / PLAT-01)

## Config keys (new)

Both are arrays of typed objects (invariant 5: they survive the Homebridge UI round trip). Default: empty list. Validated in `platform/runtime-config.ts` → `platform/exposure-opt-in-config.ts`; invalid rows are dropped and named in the grouped startup warning "Configuration: N value(s) ignored or adjusted".

### `exposeOutputs`

| | |
|---|---|
| Type | array of `{ outputId: string, exposeAs: "light" }` |
| Default | `[]` (no output of an unrecognized category is exposed) |
| `outputId` | panel output ID. Schema: `type: string`, `required: true`, `pattern: "^[0-9]+$"`, placeholder `"12"`. At runtime also accepted: a number, spaces around the digits, and the device ID forms `light_12` / `output_12`. |
| `exposeAs` | `type: string`, `enum: ["light"]`, `default: "light"`. A row without it means `light`. Any other value: the row is ignored and the output stays hidden. |
| Duplicates | two rows for the same output: the last one wins (warned). |
| Effect | only on outputs whose category the plugin does not recognize (`GEN`, `IRR`, missing, unknown). A row for a LIGHT/ROLL/GATE/thermostat output, or for an ID the panel does not list, changes nothing and is listed in the exposure warning. |

Schema text:
- title EN: "Expose these outputs anyway" · IT: "Esponi comunque queste uscite"
- description EN: "Outputs of a category the plugin does not recognize (GEN such as sirens, alarm bridges, indicators, door strikes; IRR irrigation; no category) are not exposed to HomeKit, Matter or MQTT and cannot be controlled. Add an output here only if it is safe to switch it from voice assistants, scenes and automations (\"turn off all the lights\" included). The startup log lists the hidden outputs with the exact entry to add." · IT: "Le uscite di una categoria che il plugin non riconosce (GEN come sirene, ponti allarme, indicatori, elettroserrature; IRR irrigazione; senza categoria) non sono esposte a HomeKit, Matter e MQTT e non sono comandabili. Aggiungi un'uscita qui solo se è sicuro azionarla da assistenti vocali, scene e automazioni (compreso \"spegni tutte le luci\"). Il log di avvio elenca le uscite nascoste con la riga esatta da aggiungere."
- `outputId` title EN "Output ID (panel)" · IT "ID uscita (centrale)"; `exposeAs` title EN "Expose as" · IT "Esponi come", enum label EN "Light (on/off)" · IT "Luce (on/off)".

### `exposeScenarios`

| | |
|---|---|
| Type | array of `{ scenarioId: string }` |
| Default | `[]` |
| `scenarioId` | panel scenario ID. Schema: `type: string`, `required: true`, `pattern: "^[0-9]+$"`, placeholder `"4"`. At runtime also a number, spaces around the digits, or `scenario_4`. |
| Effect | only on scenarios whose category is neither `GEN` nor an arming category (missing, empty, unknown such as `ARM_AWAY`). Never exposes `ARM`/`DISARM`; `PARTIAL` follows `exposePartialArmScenarios` only. Rows with no effect are listed in the exposure warning. |

Schema text:
- title EN: "Expose these scenarios anyway" · IT: "Esponi comunque questi scenari"
- description EN: "Scenarios are exposed only when the panel lists them as generic (GEN). Scenarios with no category or an unknown one are hidden and cannot be run; list one here to expose it. Arming and disarming scenarios (ARM, DISARM) are never exposed; partial arming (PARTIAL) only with \"Expose partial-arm scenarios\"." · IT: "Gli scenari sono esposti solo se la centrale li indica come generici (GEN). Gli scenari senza categoria o con una categoria sconosciuta sono nascosti e non eseguibili: elencalo qui per esporlo. Gli scenari di inserimento e disinserimento (ARM, DISARM) non sono mai esposti; l'inserimento parziale (PARTIAL) solo con \"Esponi scenari di inserimento parziale\"."
- `scenarioId` title EN "Scenario ID (panel)" · IT "ID scenario (centrale)".

### Layout
In the section that holds `exposePartialArmScenarios` and the `exclude*` lists (device selection), right after `exposePartialArmScenarios`, as two `type: "array"` blocks with `orderable: false` and `buttonText` "Add output" / "Aggiungi uscita", "Add scenario" / "Aggiungi scenario", items `exposeOutputs[].outputId`, `exposeOutputs[].exposeAs` and `exposeScenarios[].scenarioId` (same pattern as `matterRecoveryRequests`).

No numeric key: nothing to add to `runtime-config-limits.ts`.

## Changelog entries (2.3.0)

### Security
- Outputs of a category the plugin does not recognize are no longer exposed as lights. Sirens (`GEN`/`AT`), alarm bridges (`GEN`/`A`), indicators (`GEN`/`S`), generic relays (`GEN`/`M`, `GEN`/`B`), irrigation (`IRR`) and outputs without a category used to appear in Apple Home, Alexa and on MQTT as lights that "turn off all the lights", scenes and automations could switch, with the stored PIN. They are now hidden and cannot be commanded; `exposeOutputs` brings back a specific output. Lights, shutters (`ROLL`), gates (`GATE`) and thermostats are exposed as before. (WS-01, PLAT-05)
- Scenarios are exposed by allowlist: only generic scenarios (`GEN`) run without an opt-in. A scenario with no category, an empty or non-text one, or one the plugin does not know (for example `ARM_AWAY`) is no longer exposed nor run with the stored PIN; `exposeScenarios` brings back a specific one. Arming and disarming scenarios stay never exposed, and partial arming still needs `exposePartialArmScenarios`. (WS-02, PLAT-01)

### Added
- `exposeOutputs` and `exposeScenarios`: per-device opt-in lists for outputs and scenarios of an unrecognized category. (WS-01, WS-02)
- One warning at startup lists every hidden output and scenario with its category (and mode) and the exact `exposeOutputs` / `exposeScenarios` entries to add, plus opt-in entries that have no effect. It is repeated only if the situation changes. (WS-01, WS-02)
- The panel's per-scenario PIN flag is now read. Its meaning is not established yet, so it does not change what is exposed: exposed scenarios with a flag other than `N` are listed in the startup warning for the user to check. (WS-02)

### Changed
- An output of category `GATE` with mode `m` (lower case) is now a gate, like `M`. (PLAT-05)

## Migration notes (2.2.0 → 2.3.0)
- **Outputs that were exposed as lights may disappear.** Any output whose panel category is not LIGHT, ROLL, GATE or a thermostat category (typically `GEN` relays) was a light in 2.2.0 and is hidden from 2.3.0. At the first startup the log shows a warning starting with `Exposure policy:` that names each hidden output and ends with a line such as
  `"exposeOutputs": [{"outputId":"12","exposeAs":"light"}, {"outputId":"13","exposeAs":"light"}]`.
  To keep one, add its entry (only the ones that are safe to switch by voice/scenes) to the plugin settings ("Expose these outputs anyway") or to the platform block of `config.json`, then restart. The output comes back with the same device ID (`light_<id>`) and therefore the same HomeKit accessory UUID and the same MQTT topic.
- Scenarios without a category or with an unknown category disappear the same way; the warning gives the `"exposeScenarios": [...]` line.
- Accessories of hidden devices restored from the HomeKit/Matter cache are not commandable (the client does not know them: see the requests to tasks B, C and the platform wiring below) and are removed: on HomeKit like an excluded device once the platform asks the client which devices it hid, on Matter by the normal 3-sync prune.
- Retained MQTT state topics of now-hidden devices published by 2.2.0 are not cleared automatically; delete them on the broker if needed.
- Nothing else changes: IDs, UUIDs, topics and existing keys are the same.

## Documentation notes
- README EN/IT "Supported devices": replace the "currently not supported" list for GEN/IRR with: not exposed by default, can be exposed one by one with `exposeOutputs` (as a light); explain the safety reason (group commands and scenes act on every light).
- README EN/IT scenarios section: allowlist (GEN only), ARM/DISARM never, PARTIAL with `exposePartialArmScenarios`, others with `exposeScenarios`; the PIN flag is reported, not acted upon (meaning to be confirmed on a real panel).
- Troubleshooting: the `Exposure policy:` warning and how to use its config lines; "an output/scenario disappeared after updating to 2.3.0".
- ARCHITECTURE: exposure policy = `websocket/output-classifier.ts` (`determineOutputType` returns `undefined` for unrecognized categories, `resolveOutputExposure`) and `websocket-client/device-parsers.ts` (`resolveScenarioExposure`, `isIgnoredScenarioCategory(category, exposePartialArm, optedIn)`), applied in `discovery-read-handler.ts` / `scenario-discovery.ts` before anything enters `state.devices`; hidden devices recorded in `state.hiddenByExposurePolicy` (`exposure-report.ts`, `isHiddenByExposurePolicy`); `DiscoveryService.attachExposurePolicy` makes them count as excluded on the platform side.
- `ksaImport.applyExclusionSuggestions` (task G) has nothing left to do for GEN/IRR outputs: they are hidden by default.

## Wiring left to other tasks (not my files)
The fail-closed default works everywhere already. These are needed for the opt-ins and for the platform side to take effect:
1. **C — `websocket-client/index.ts` and `message-service.ts`**: forward `this.options.exposeOutputs` / `exposeScenarios` to `MessageService` and from there to `DiscoveryReadHandler` (deps `exposeOutputs`, `exposeScenarios`, same path as `exposePartialArmScenarios`). Without it no opt-in reaches discovery.
2. **C — `websocket-client/index.ts`**: `isScenarioSuppressed` must pass the opt-in (`isIgnoredScenarioCategory(category, partial, scenarioOptInIds(this.options.exposeScenarios).has(id))`), and a facade method `isHiddenByExposurePolicy(deviceId)` returning `isHiddenByExposurePolicy(this.state, deviceId)` (from `exposure-report.ts`). `state.ts`: initialize `hiddenByExposurePolicy: new Map()` (then the field can become required).
3. **B — `command-service.ts` `assertScenarioAllowed`**: pass the opt-in as third argument (same expression as above) and word the error by `resolveScenarioExposure(...).reason` (today an unknown category is refused with "arms or disarms the alarm"). Defence in depth for outputs (command to an output that is not a discovered device of that type is refused) is what makes cached accessories of hidden outputs inert.
4. **Platform (`platform/index.ts`, unowned in wave 1) / F1**: after creating the client, `discoveryService.attachExposurePolicy(wsClient)`; F1's HAP handling of policy-suppressed scenarios can use the same `isDeviceExcluded`.
5. **G — `ksa/derive.ts`**: `determineOutputType` now returns `undefined` for unrecognized categories; room mapping builds `${type}_${id}` and would produce `undefined_<id>`: use `light_<id>` for those (the ID an opted-in output gets).
