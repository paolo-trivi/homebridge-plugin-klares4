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

### Fixed
- An output reconfigured on the panel (for example from `LIGHT` to `GATE`) is no longer kept with its old type until a restart: an explicit category always wins over the type remembered from an earlier read, so a former light that is now a gate is not switched by "turn on all the lights". The remembered type is still used when a re-read does not name a category, so a partial re-read never changes a device's identity. (COMMS-07)

## Migration notes (2.2.0 → 2.3.0)
- **Outputs that were exposed as lights may disappear.** Any output whose panel category is not LIGHT, ROLL, GATE or a thermostat category (typically `GEN` relays) was a light in 2.2.0 and is hidden from 2.3.0. At the first startup the log shows a warning starting with `Exposure policy:` that names each hidden output and ends with a line such as
  `"exposeOutputs": [{"outputId":"12","exposeAs":"light"}, {"outputId":"13","exposeAs":"light"}]`.
  To keep one, add its entry (only the ones that are safe to switch by voice/scenes) to the plugin settings ("Expose these outputs anyway") or to the platform block of `config.json`, then restart. The output comes back with the same device ID (`light_<id>`) and therefore the same HomeKit accessory UUID and the same MQTT topic.
- Scenarios without a category or with an unknown category disappear the same way; the warning gives the `"exposeScenarios": [...]` line.
- Accessories of hidden devices restored from the HomeKit/Matter cache are removed like excluded devices: on HomeKit at the first sync, on Matter by the normal 3-sync prune; they are never registered again and cannot run commands.
- Retained MQTT state topics of now-hidden devices published by 2.2.0 are not cleared automatically; delete them on the broker if needed.
- **Device IDs.** Every output 2.2.0 exposed and 2.3.0 still exposes keeps exactly its 2.2.0 ID (`light_`, `cover_`, `gate_`, `thermostat_` + panel ID), hence the same HomeKit UUID, Matter endpoint and MQTT topic: the classification of recognized categories is the 2.2.0 one, comparison for comparison (category upper-cased but not trimmed, `MOD` compared as `M`; `GATE` with `m` stays a cover). A test compares the two over a grid of categories and modes. The only outputs that change are those 2.2.0 exposed as lights by default (unrecognized category, including a recognized name with surrounding spaces such as `" ROLL"`): they are hidden, and `exposeOutputs` brings them back with their old `light_<id>`.
- An output reconfigured on the panel to another recognized category gets the ID of its new type (`light_15` → `cover_15`), as a newly installed output would: the new accessory appears, the old one stops receiving commands and states at once and is removed by the usual prune (3 syncs; a sync is one login, so with a stable connection this can take until the next restarts or reconnections). Rooms and automations of the old accessory do not carry over. 2.2.0 instead kept the old type (and the old ID) when the new category was `GATE` without a mode.
- Existing config keys, scenario IDs and zone/sensor IDs are unchanged.

## Documentation notes
- README EN/IT "Supported devices": replace the "currently not supported" list for GEN/IRR with: not exposed by default, can be exposed one by one with `exposeOutputs` (as a light); explain the safety reason (group commands and scenes act on every light).
- README EN/IT scenarios section: allowlist (GEN only), ARM/DISARM never, PARTIAL with `exposePartialArmScenarios`, others with `exposeScenarios`; the PIN flag is reported, not acted upon (meaning to be confirmed on a real panel).
- Troubleshooting: the `Exposure policy:` warning and how to use its config lines; "an output/scenario disappeared after updating to 2.3.0".
- ARCHITECTURE: exposure policy = `websocket/output-classifier.ts` (`determineOutputType` returns `undefined` for unrecognized categories, `resolveOutputExposure`) and `websocket-client/device-parsers.ts` (`resolveScenarioExposure`, `isIgnoredScenarioCategory(category, exposePartialArm, optedIn)`), applied in `discovery-read-handler.ts` / `scenario-discovery.ts` before anything enters `state.devices`; hidden devices recorded in `state.hiddenByExposurePolicy` (`exposure-report.ts`, `isHiddenByExposurePolicy`); `DiscoveryService.attachExposurePolicy` makes them count as excluded on the platform side.
- `ksaImport.applyExclusionSuggestions` (task G) has nothing left to do for GEN/IRR outputs: they are hidden by default. The KSA room mapping lists such an output as `light_<id>`, the ID it gets when re-exposed with `exposeOutputs` (until then the entry matches no device).

## Decisions to confirm with the user
1. **Reconfigured output = new device** (COMMS-07). An explicit, recognized category different from the remembered one gives the output its new type and ID; the old accessory is pruned after 3 syncs. Alternative: keep the old ID with the new behaviour (impossible without changing the ID ↔ type rule) or hide the output until a restart. Chosen because it is what discovery does for any new output and what task C's removal of no-longer-listed devices expects.
2. **2.2.0 classification kept literally** (COMMS-08), including its oddities: `GATE` with `m` is a cover, `" ROLL"` (with spaces) is not recognized and is now hidden. Real captures always send `CAT`/`MOD` in upper case without spaces.
3. **Type memory is per client** (one per panel connection), no longer shared by every instance in the process. It covers only re-reads without a category, and `GATE` without `MOD` for an output already known as a gate or a cover from a `GATE` read.

## Implementation notes
- `OutputTypeMemory` lives in `DiscoveryReadHandler` (one per client). The type it decides for a discovery element reaches `parseOutputDevice` (task C's projector, which calls `classifyOutput(outputData)`) through a `WeakMap` keyed by that element. A cleaner follow-up for C: give `parseOutputDevice` an explicit `type` parameter and drop the `WeakMap`.
- The wiring to tasks B and C is done (`isHiddenByExposurePolicy` on the facade, opt-ins forwarded, command guard).
