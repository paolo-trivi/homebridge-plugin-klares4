# Matter

With **Homebridge 2.x** every accessory of the plugin is also exposed over Matter, next to HomeKit and MQTT. This page describes how the Matter side behaves and how to troubleshoot it.

## Versions

- Homebridge **2.5.x** (matter.js 0.18) is the verified version: the contract tests run against the real Homebridge Matter stack, with every accessory type, native Thermostat included.
- Homebridge **2.4.x** is covered by a CI contract job. There the register and unregister calls return before the endpoint exists; the plugin observes this itself and keeps a long wait where registration completes later.
- Homebridge 1.x has no Matter support and is not tested.
- Matter commissioning, pairing and the Matter child bridge belong to Homebridge. **Never delete or regenerate the child bridge** to fix a problem: the commissioned fabrics are lost and every controller must pair again.

## What Is Exposed

All devices the plugin exposes (see the README, [Exposure policy](../../README.md#exposure-policy-fail-closed)), minus what you turn off: `matterExposure` by type, `matterOverrides` by device, and the `exclude*` lists. Matter-only settings never change HomeKit or MQTT. Precedence: exclusion lists, then per-device `exposed`, then the type in `matterExposure`, then the default (exposed).

## Thermostats

- **Native Thermostat.** A thermostat registers as a real Matter Thermostat declaring only the attributes of what it can do. Homebridge 2.5 derives the features from them: a heating-only output has heating and no cooling, no Auto, no Occupancy; a cooling-only one the reverse; an output that does both keeps heating, cooling and Auto. The role comes from the panel's thermostat program data (or the panel's own output name), never from a name you set in `matterOverrides` or `customNames`. At a first start without a `.ksa` cache the thermostat appears once the program data has arrived (at most 20 seconds); if the program is changed on the panel later, the thermostat is replaced and keeps its identity.
- **Running state.** The thermostat publishes whether its heating or cooling output is running.
- **One program, two outputs.** A heating output and a cooling output of the same program appear as two thermostats. Each shows Off outside its season and refuses a setpoint or mode there; the heating output does not forward Off while the program runs in summer (it would stop the cooling).
- **A refused command is reported.** Auto or Cool on a heating-only thermostat is refused to the controller instead of being accepted and ignored. A command that cannot reach the panel fails visibly and the previous value comes back.
- **Quick commands.** A command sent shortly after another is not dropped as "already current" because the panel had not reported the first yet; two quick +1 °C steps add up to +2 °C. A step given right after a change made on the keypad or in HomeKit starts from that change.
- **Unknown temperature.** A thermostat whose room temperature has not been read shows it as unknown, not as a made-up 20 °C.
- **Ranges.** Fixed: heating 5-30 °C, cooling 16-35 °C. `temperatureDefaults` does not apply to Matter.

### Fallback and automatic recovery

If a Homebridge version refuses the native Thermostat endpoint, the plugin tries once more with the payload of earlier versions (log: `trying the payload of earlier versions before falling back to TemperatureSensor`). If that is refused too, the thermostat registers as a read-only **temperature sensor** and the choice is saved in `klares4-matter-fallback.json`.

- A thermostat that an earlier version saved as a temperature-sensor fallback gets **one automatic attempt** at the first start of 2.3.0, without any setting (log: `was saved as a TemperatureSensor fallback by an earlier version; trying the native Thermostat once`). If Homebridge does not accept it, the sensor comes back with the identity it had (rooms and automations stay) and no further automatic attempt is made.
- `matterRecoveryRequests` allows one more explicit attempt for a device: `[{ "deviceId": "thermostat_18", "generation": 1 }]`. The generation is consumed once and saved before the change; raise the number only for a deliberate retry; do not raise it at every start. On failure or an interrupted recovery the plugin returns to the temperature sensor. Never delete the fallback store.
- A file the plugin does not understand (a newer version, an unknown layout) is left untouched and the state is kept in memory. An unreadable file is copied to `klares4-matter-fallback.json.unreadable.bak` before a new store starts. The store gains the optional fields `nativeShape` and `nativeShapeRevision`, which 2.2.0 ignores.
- The payload that worked is remembered in the store: on a Homebridge version that accepts only the earlier payload the plugin starts from it at the next start instead of being refused once per thermostat, and moves to the other payload by itself if the remembered one is refused later.

### Identity

A replacement keeps the endpoint's `uniqueId` only when the new endpoint is the same device with the same function: a rename, another payload of the same device type, a light that becomes a dimmer. **Thermostat ↔ temperature sensor changes the function and therefore the identity on purpose**: a controller that kept the identity could keep scenes that set a temperature on a read-only sensor. Apple Home, Alexa and Google then show a new accessory: rooms and automations that used the sensor must be set again. This happens once for the thermostats that were sensors in 2.2.0. The reverse is not a change of function: a sensor whose recovery fails comes back as the same sensor, with its identity.

## Names and Renames

- Names come from the panel (or `customNames`, `matterOverrides`), are cleaned (trim, characters HomeKit rejects replaced) and are resolved in one batch so the same set of devices always converges to the same names. The controllable device owns the clean name; a passive sensor with the same label gets a ` - Sens.` suffix.
- The Matter name limit (32) is counted in UTF-16 code units, like Homebridge and matter.js, so a character is never cut in half and two accessories cannot end up with the same truncated name. HomeKit names count characters (64).
- `klares4-matter-names.json` keeps the names stable across restarts. Names of devices still on the panel never expire; the name of a device that disappeared is reserved for 30 days from when it was last seen. The file is written atomically and one written by a newer version is left untouched after a downgrade.
- **Rename in place.** A name change (panel label, `matterOverrides`, a collision resolved at the end of the first sync) is written on the live accessory (`nodeLabel`), which keeps its identity: controllers keep rooms, favourites and automations. Only if the new name does not show up does the plugin fall back to remove-and-add, and that path keeps the identity too. A first rename of a brand-new accessory can log once, from Homebridge, `Cannot update Matter accessory ... not found in cache`: harmless, the name persists. `productLabel` is not rewritten in place; Homebridge sets it at the next start.
- A light that turns out to be a dimmer is replaced once by a dimmable accessory (Matter cannot change a device type in place) and keeps its identity; it is absent for about a second.
- The voice analysis at the end of each sync is diagnostic only and never renames anything.

## Removal (prune)

A device deleted or renumbered on the panel is removed from Matter after **three complete synchronizations**, across restarts, without restarting Homebridge (a reconnection is a synchronization too). The rules, shared with HomeKit:

- an accessory counts as missing only if its kind of device (zones, outputs, scenarios, sensors) answered in that synchronization; a failed read on reconnect advances nobody;
- three consecutive misses are needed (counters in `klares4-matter-prune.json`, cleaned of accessories that no longer exist);
- a synchronization that sees fewer than half of the known accessories counts nobody as missing (log: `Prune: discovery returned X of Y exposed endpoint(s), below the 50% safety floor`);
- the panel's own temperature probes are never removed;
- the last device of a family (the only scenario, for example) is not removed automatically, because an empty list cannot be told from a failed read: remove it with the matching `exclude*` list, which acts at the first synchronization;
- endpoints restored from Homebridge's cache and not registered in this session are judged in the same pass.

The log line `[Matter] Missing candidate: ...` names a device that is absent for a number of syncs; check it still exists on the panel. The Matter cycle summary reports `missingCandidates` and `keptFamilyNotAnswered`.

## Reachability

When the panel connection is down, every Matter accessory of the plugin is marked "not responding" after **15 seconds**, including those Homebridge restored from its cache: a Homebridge restart during a panel outage no longer shows the last cached states as live. They return when a synchronization with the panel has completed, not at the login (log: `[Matter] panel reachable again`): a panel that accepts the login but refuses the data reads does not make cached states look live. A normal reconnection completes well within the 15 seconds, so the accessories do not blink.

## Covers, Dimmers, Gates and Scenarios

- A cover commanded from Matter keeps the position the panel reports as `current`, shows the requested `target` and reports opening or closing until the panel shows it at the target. Automations on "cover closed/open" do not fire at the command.
- A brightness command on a dimmer that is off does not reach the panel.
- Gates and scenarios are momentary switches.
- A Matter command arriving while the panel connection is not available fails visibly in the controller.
- A command and a state update of the same accessory never overlap (an update applied while Homebridge ran a command made the command fail in the controller with an internal lock error, although the panel had carried it out). A command that arrives while the plugin is updating that accessory waits for the update, up to about 150 ms more.

### Known limits (Homebridge, not fixable with the public API)

- LevelControl `moveWithOnOff`, `stepWithOnOff` and `stopWithOnOff` run matter.js's default implementation without calling a plugin handler: a controller that uses them changes the Matter state while the panel does nothing, and the next panel status puts the state back. None of Apple Home, Alexa or Google is known to use them for a plain dimmer.
- The unregister settle of 1 second is kept (Homebridge 2.4 reports an endpoint as absent while it is still closing).

## Registration Timing

Homebridge 2.5 completes a registration before returning; on 2.4 it completes later. The plugin learns which from observation: where registration completes before returning, an accessory that did not come up is retried after about 2 seconds; elsewhere the long wait (30 s) stays. An endpoint counts as up only when it answers for **every** cluster the plugin declared.

## Troubleshooting

| Symptom or log line | Meaning and action |
|---|---|
| `... was saved as a TemperatureSensor fallback by an earlier version; trying the native Thermostat once` | The automatic recovery. Watch the next lines: success, or the reason it fell back again |
| `trying the payload of earlier versions before falling back to TemperatureSensor` | Homebridge refused the conformant payload; the second attempt follows |
| A thermostat shows as a temperature sensor | It fell back. Check the log for the reason; `matterRecoveryRequests` allows one more attempt |
| Apple Home / Alexa show a new thermostat and the sensor is gone | Expected once after updating from 2.2.0 (the identity changes on purpose). Set rooms and automations again |
| `[Matter] Missing candidate: ...` | A device absent from the panel for some syncs; it leaves after three |
| `Prune: discovery returned X of Y ... below the 50% safety floor` | A partial sync: nothing is removed. Usually harmless; look at the panel connection |
| `Fallback store ... is unreadable ... a copy is kept in ...unreadable.bak` | The store was damaged; the plugin keeps a copy and starts a new one |
| `register deferred: ... the Matter server is still starting` | Matter was not up yet; the registration is retried on a later update |
| `Cannot update Matter accessory ... not found in cache` (Homebridge) | A rename of a brand-new accessory before Homebridge saved its cache. Harmless |
| `HomeKit (HAP) limit reached` | More than 149 accessories on one bridge: the rest stays on Matter and MQTT |
| "No handler registered for thermostat_N..." | Plugins older than 2.1.3 only; update |

## Network and mDNS Diagnostics

Matter discovery and commissioning use mDNS (multicast DNS, UDP port 5353). The plugin does **not** configure network interfaces; which interfaces are advertised is up to Homebridge and matter.js.

**Symptoms:** pairing fails or is intermittent; the bridge is visible from one controller and not from another; the boot log warns `Detected another IPv4 mDNS stack running on this host`; a controller on another VLAN cannot find the bridge after a reset.

1. **Conflicting mDNS responders.** Another mDNS stack on the same network namespace (Avahi, mDNSResponder, Bonjour, a host-network container) competes for UDP 5353. Check with `systemctl status avahi-daemon` or `ps aux | grep -E 'avahi|mDNSResponder|bonjour'`. Run Homebridge in its own network namespace, disable what you do not need, or restrict Avahi to specific interfaces.
2. **Firewall.** Multicast UDP 5353 must be open on the relevant interfaces (`iptables -L INPUT -v -n | grep 5353`, `ufw status | grep 5353`).
3. **Same segment.** The controller and the Homebridge host must be on the same layer-2 segment, or multicast must be forwarded between them. Test with `ping -c 3 224.0.0.251` and `ping6 -c 3 ff02::fb%<iface>`. VLANs that block multicast prevent discovery.
4. **Interface choice.** Check the interface the Homebridge log reports and `ip route show default`; make sure the controller is on the subnet of that interface.

## Environment Variables (diagnostics only)

These are read when the Matter registry is built. They exist for tests and emergencies; do not set them in normal use. Times are in milliseconds.

| Variable | Default | Meaning |
|---|---|---|
| `KLARES4_MATTER_REGISTER_TIMEOUT_MS` | 30000 | Wait for a new endpoint to answer, until the runtime has shown that register waits for it |
| `KLARES4_MATTER_SETTLED_REGISTER_TIMEOUT_MS` | 2000 | The same, once the runtime has shown that register resolves with the endpoint already built |
| `KLARES4_MATTER_REGISTER_POLL_MS` | 250 | Polling interval of that wait |
| `KLARES4_MATTER_REGISTER_POLL_MAX_MS` | 1000 | Longest polling interval |
| `KLARES4_MATTER_REGISTER_RETRY_MS` | 5000 | Wait before a registration refused as transient ("still starting") may be retried (0 allowed) |
| `KLARES4_MATTER_STATE_BOOTSTRAP_MS` | 0 | Extra delay before state updates reach a freshly registered endpoint (emergency override; 0 allowed) |
| `KLARES4_MATTER_UNREACHABLE_GRACE_MS` | 15000 | Time before the accessories are marked not responding (0 allowed) |
| `KLARES4_MATTER_UNREGISTER_SETTLE_MS` | 1000 | Wait after a removed endpoint first reads as absent, before it is checked again (0 allowed) |
| `KLARES4_MATTER_UNREGISTER_TIMEOUT_MS` | 3000 | Wait for a removed endpoint to disappear, when `matterUnregisterTimeoutMs` is not set |

## Diagnostic Commands

```bash
# Homebridge log (Docker example)
docker logs <homebridge-container> --tail 200 -f | grep -i matter

# Installed plugin version
grep '"version"' /path/to/node_modules/homebridge-plugin-klares4/package.json
```
