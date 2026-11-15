# G — Platform, HAP, persistence, KSA

Findings: PLAT-03, PLAT-07, PLAT-11, PLAT-12, PLAT-14, PLAT-15, PLAT-16, PLAT-17.

## Config keys

No key added, renamed or changed.

One key is retired:

| Key | Change |
|---|---|
| `ksaImport.applyExclusionSuggestions` | Still accepted (no validation warning, existing configs keep working) but ignored: with fail-closed exposure the plugin hides what it does not expose by default, and the KSA import never touched the `exclude*` lists anyway (the suggestions were always empty). When it is `true`, one startup line says so. **Remove it from `config.schema.json`**: the property (about line 479), its default in the `ksaImport` block (about line 443) and its entry in the layout (`ksaImport.applyExclusionSuggestions`, about line 901). The runtime reader (`runtime-config-sections.ts`) and its row in the runtime table can stay as "accepted and ignored". |

## Changelog entries (2.3.0)

### Security
- Files the plugin creates for the first time (debug capture, KSA cache, Matter stores, device list, room mapping example) are now private (`0600`) instead of following the umask. Existing files keep the permissions they have. The temporary file used for atomic writes is created exclusively under an unpredictable name, and leftover temporary files from a crash (for `config.json` they contained the PIN) are removed at startup once they are older than five minutes. (PLAT-16)
- A `.ksa` backup is treated as untrusted input: IDs derived from it must be plain numbers and names are cut to 64 characters before they can reach `config.json`, and a file over 32 MB is refused with a clear error instead of blocking Homebridge for seconds. (PLAT-17)

### Changed
- The KSA import no longer rewrites your thermostat mappings. `domusThermostat.manualPairs` and `manualCommandPairs` that you configured always win; the backup only adds pairs for thermostats you have not mapped, and an empty backup never empties your lists. When one of your pairs differs from the backup, one line in the log names the thermostat and both values. Previously the backup replaced both lists at every start while `ksaImport.enabled` was on. (PLAT-03)
- `ksaImport.applyExclusionSuggestions` is ignored (see above). (PLAT-17)
- The device summary ("AVAILABLE DEVICES") and `klares4-room-mapping-example.json` are produced at the first synchronization and again only when the list of devices changes, not at every reconnection; the example file is written atomically and only when its content differs. (PLAT-14)

### Fixed
- `config.json` that is a symbolic link (dotfiles repository, NAS) stays a link: the file it points to is updated. In 2.2.0 the link was replaced by a regular file and the original diverged. (PLAT-07)
- When `config.json` cannot be replaced atomically (for example it is bind-mounted as a single file in Docker, `EBUSY`), the plugin rewrites it in place and logs a warning, instead of failing silently and leaving `generateDebugFile` or the KSA `applyAtStartup` switched on forever. (PLAT-07)
- The plugin no longer reports "KSA import applied to config.json" or "Debug flag disabled" when the write did not happen. A failed write is logged, the flags stay as they were and the operation is retried at the next start. (PLAT-07)
- With more than one `Lares4Complete` block in `config.json`, the one that belongs to the running instance is updated (matched by `name`, then `ip`); if it cannot be told apart nothing is written and a warning explains how to fix it. (PLAT-07)
- HomeKit: a temperature, humidity, light, motion or contact sensor the panel has never reported (typical for an offline DOMUS) shows "No Response" instead of 0 °C, 50 %, 100 lux or "no motion", which could satisfy automation conditions. (PLAT-11)
- HomeKit: setting the brightness of a light that is not dimmable is an error instead of a silent success. A cover whose position the panel has not reported yet (or whose position was only simulated) now always sends the command, also when the requested position equals the one HomeKit believes. (PLAT-12)
- HomeKit and Matter: a DOMUS sensor (or a cover position) the panel has never reported no longer comes back as 0 °C, 50 %, 100 lux or position 0 after a Homebridge restart. "Reported by the panel" is now stored with the accessory in the Homebridge cache, next to the value, and written only when a real status arrives. (PLAT-11)
- A leftover temporary file next to the destination of a symlinked `config.json` is cleaned at startup too. In the KSA import, custom-name rows that are not objects are dropped instead of being rewritten as `{}`. (PLAT-07, PLAT-17)
- A scenario renamed on the panel is updated in its HomeKit handler (the MQTT command by the new name works without a restart). The HomeKit gate auto-off uses `scenarioAutoOffDelay`, like the Matter gate and the scenarios, instead of a fixed 500 ms. (PLAT-15)

## Migration notes
- KSA import: if you relied on the backup overwriting your thermostat pairs, delete the pair you want replaced from the plugin settings (or set `applyDomusMappings` to `false` and manage the pairs by hand); the backup fills in the ones that are missing.
- `ksaImport.applyExclusionSuggestions` can be deleted from the config; leaving it does no harm.
- No change to persisted data, UUIDs, topics or other config keys. Files that already exist keep their permissions; only new ones are `0600`.

- Upgrading from 2.2.0: the cache written by 2.2.0 has no "reported" marker, so the cached value of every sensor and every cover position is treated as a placeholder until the panel reports it (normally within seconds of the first synchronization). Until then HomeKit shows "No Response" for the sensors and Matter shows an unknown measurement. Lights, zones, gates, scenarios and thermostats are not affected: their cached state is kept. A sensor that is really offline stays "No Response" instead of showing 0 °C, as intended.

## Documentation notes
- Troubleshooting, new log lines:
  - "KSA import: keeping your domusThermostat.manualCommandPairs entry for thermostat_N (X); the backup has Y" (info): your pair differs from the backup; nothing to do unless the panel was reprogrammed.
  - "KSA import was applied for this run but could not be saved to config.json (...)" (warn): the import runs again at the next start; check that `config.json` is writable.
  - "config.json could not be replaced atomically (EBUSY); rewriting it in place" (warn): typical with a single-file Docker bind mount; mount the Homebridge directory instead.
  - "config.json has N "Lares4Complete" blocks and none can be told apart as this instance" (warn): keep a single block (the schema declares it singular) or give each a distinct `name`.
  - "KSA file is too large (X MB; the limit is 32 MB)" (error).
  - "Removed N leftover temporary file(s) from the Homebridge storage directory" (info).
  - "ksaImport.applyExclusionSuggestions is ignored: ..." (info).
- README / docs (EN and IT): `applyDomusMappings` description becomes "adds the thermostat mappings of the backup that are missing; the pairs you configured are never replaced"; drop `applyExclusionSuggestions` from the KSA tables; HomeKit sensors show "No Response" until the panel reports a value; the summary of devices is printed once per change of the list.
- ARCHITECTURE: observed state. `device-observation.ts` keeps one notion of "observed" for HAP, Matter and MQTT: in memory a WeakSet of placeholder statuses, persisted as `context.panelReported = 1` (versioned) next to `context.device` in the HAP cache (`AccessoryRegistry`) and the Matter cache (`MatterAccessoryRegistry`, `matter-registry-state.ts`, mapper `context`); `adoptCachedState` classifies a restored device (sensors and covers only), `recordObservation` keeps the marker in step. MQTT only publishes the live state of the session, never the cache.
- ARCHITECTURE: `atomic-file.ts` (`writeFileAtomic` returns `{ method, path }`; options `mode`, `onInPlaceFallback`, `fileSystem`; `removeOrphanedTemporaryFiles`), `PlatformConfigFileService.updatePlatformConfig` returns a `ConfigUpdateOutcome` (`written | unchanged | no-platform-block | ambiguous | failed`), `platform/room-mapping-example.ts`, `ksa/parser.ts` `MAX_KSA_FILE_BYTES`.

## Integration done in `platform/index.ts`
- `disableDebugFlag(PLATFORM_NAME, { name, ip })`: with several `Lares4Complete` blocks the debug flag is switched off in the block of the running instance.
- `removeOrphanedTemporaryFiles()` runs once at the start of `initializeLares4`, before the KSA import.
- After the KSA import only the sections it can change (`domusThermostat`, `roomMapping`, `customNames`, `ksaImport`) are read again (`refreshKsaSections` in `runtime-config.ts`): configuration warnings and informative lines are never repeated, and a problem introduced by the import itself is still reported.

## Points to verify in the field
- A real HomeKit read of an offline DOMUS sensor shows "No Response" (not 0).
- With `ksaImport.enabled` and thermostat pairs set by hand, the thermostat writes keep going to the configured program ID after a restart.
