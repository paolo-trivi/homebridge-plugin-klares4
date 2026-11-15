# L — Documentation and schema

Files: `config.schema.json`, `README.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, `SECURITY.md`, `docs/**`, package metadata (`description`, `displayName`, `keywords`), tests `test/config-schema*.test.js`, `test/docs-*.test.js`, `test/package-metadata.test.js`, fixtures `test/fixtures/schema-model.js` and `test/fixtures/markdown.js`. No change to `src/`.

## Language of the settings form
English (README main text is English, logs are English, the package is published for an international audience). The form is no longer Italian: the log line of `override-reconciliation.ts` still quotes the Italian label (see below).

## Divergences code ↔ documentation that need a CODE change (for other tasks)

1. `src/platform/override-reconciliation.ts:47`: the warning says `untick "Esposto su Matter"`; the form label is now **"Exposed on Matter"** (`matterOverrides[].exposed`). Fix the string (and its test if it pins the text). `docs/en|it/operations-debug.md` already quote the English label.
2. `ksaImport.applyExclusionSuggestions` is still read (`runtime-config-sections.ts`, `ResolvedKsaImport`, `platform/types.ts`) although it does nothing and is not in the form. If task Q removes the reader, drop the entry from `NOT_IN_FORM` in `test/config-schema-runtime.test.js` and the "accepted and ignored" sentence in README/docs. Same for `telemetry?: unknown` in `platform/types.ts` and `DEPRECATED_KEYS` (keep while old configs are tolerated).
3. `src/plugin-version.ts` (comments in Italian) and `src/platform/matter-voice-analyzer.ts:25` (one generic voice phrase that the real-names check matches; functional vocabulary, not plant data): language/vocabulary clean-up for Q.
4. `matterOverrides[].exposed`: the schema default is `true` (the UI writes `exposed: true` on every row) but a row without `exposed` means "no preference", not "exposed". README states what a row with `exposed: true` does; no code change needed unless the semantics are to be aligned.
5. `matterUnregisterTimeoutMs`: the schema default 3000 means the settings UI always writes the key, so `KLARES4_MATTER_UNREGISTER_TIMEOUT_MS` can never apply to a UI-saved config. Documented as "when the key is not set"; consider removing the schema default if the variable must stay useful.

## To update after other tasks

### After J (logging)
- `logLevel` / `debug` are documented as they behave TODAY: level 2 and `debug` only add `log.debug` lines, shown only when Homebridge runs with `-D`; levels 0 and 1 behave the same; `debug` is independent of `logLevel`. After J rewrite:
  - `config.schema.json`: `properties.debug.description`, `properties.logLevel.description` (and its `oneOf` titles), layout `logLevel` description;
  - `README.md` rows `debug` and `logLevel` (EN and IT), section Troubleshooting → Logging (EN and IT), Fast Validation Checklist and Common symptoms in `docs/en|it/operations-debug.md`, Reliability and Logging in `docs/en|it/config-and-ui.md`;
  - the CHANGELOG: add a "Changed/Fixed" bullet for the logger, and the matching line in "Upgrading from 2.2.x" if the default noise changes.
- New or reworded log lines quoted in docs (tables in `operations-debug.md`, `matter.md`, README startup messages): re-check against J's wording. The English page is the source; the Italian page keeps the log text verbatim.
- If J changes the log text of messages quoted in tests of mine: none of my tests pin log text.

### After Q (quality)
- `test/docs-architecture.test.js` fails when a module is added, renamed or removed under `src/` without updating `ARCHITECTURE.md`: update the module map (dead code removal, `tls-error-hint`, `createDeviceSlug` moves).
- `target` ES2022, `noUncheckedIndexedAccess`, ESLint: mention in README Development only if a new npm script appears; update CHANGELOG "Changed" if the compile target text changes.
- If `NUMERIC_LIMITS` changes, `config.schema.json` and the README tables (limits column) must change with it; three tests fail until they match.

### Other
- Task K: the README says Homebridge 2.4.x is covered by a CI contract job; that is true only when `Contract (Homebridge 2.4.x)` is green (K reported it red until the harness is adapted).
- Repository settings for the user: enable **GitHub Private Vulnerability Reporting** (`SECURITY.md` points to it); the Homebridge "verified" badge cannot be verified from the repository (see report).

## Where each fragment went

| Fragment | Schema | README | docs | ARCHITECTURE / SECURITY | CHANGELOG |
|---|---|---|---|---|---|
| t0.1 | — | Development (`verify`, `test:contract`, `test:coverage`, `check:pack`) | operations-debug (contributors) | verification gates | Changed (tests on the real stack, synthetic fixtures) |
| t0.2 | — | HAP 149 limit | operations-debug, matter | sync lifecycle, split map | Fixed (isolation, 149 limit, exclusions on MQTT, sync) |
| t0.3 | no change; ranges documented | table limits, "How values are read" | config-and-ui (reading rules, ID forms) | runtime-config modules | Upgrading, Changed, Fixed, Security |
| A | `exposeOutputs`, `exposeScenarios` | Exposure policy, Unsupported entity types | plugin-overview, config-and-ui, operations-debug | Exposure Policy, SECURITY | Upgrading, Security, Added |
| B | — | MQTT/commands, Supported accessory types | websocket-protocol (command lifecycle) | Truth boundaries | Security, Fixed |
| C | — | Troubleshooting (login), Requirements | websocket-protocol (envelope, CRC, guard, sync, reconnect, zone fields) | connection modules | Upgrading, Security, Changed, Fixed |
| D | `commandTimeoutMs`, `sensorFreshnessMs`, `temperatureDefaults` texts | Thermostats | domus-thermostats | thermostat command path | Upgrading, Changed, Fixed, Security |
| E | — | Thermostats, Matter | matter (native Thermostat, recovery, identity), domus-thermostats | Matter thermostat modules | Upgrading, Fixed |
| F1 | — | Matter (removal, reachability) | matter (prune, reachability, timing, env vars) | prune discipline | Upgrading, Fixed, Changed |
| F2 | — | Matter (identity, names), Voice assistants | matter (names, rename in place, known limits) | Matter name modules | Fixed |
| G | `ksaImport` texts, `applyExclusionSuggestions` removed | `ksaImport.*` rows | config-and-ui (KSA import), operations-debug (new log lines) | `atomic-file`, SECURITY (file mode, untrusted `.ksa`) | Upgrading, Security, Changed, Fixed, Removed |
| H | `mqtt.commands`, `mqtt.port` text | MQTT bridge, MQTT security, ACL, status topic | mqtt | mqtt-bridge modules, SECURITY | Upgrading, Security, Fixed, Added, Changed |
| I | `telemetry` removed, `generateDebugFile`/help texts | Privacy and the debug file | privacy-and-debug-file | debug-capture modules, SECURITY (privacy) | Upgrading, Security, Changed, Removed |
| K | — | Requirements (Node 22/24/26, Homebridge), Development | operations-debug | Release and CI | Upgrading (requirements), Security (pipeline), Changed, Removed (release scripts) |
