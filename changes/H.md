# H — MQTT bridge

Files: `src/mqtt-bridge/**`, `src/mqtt/**`, `src/types/mqtt.types.ts`, `src/types/guards/**`; additive in `src/platform/runtime-config.ts` (`mqtt.commands`). Integration with wave 1 (after I, G, A, F1): `platform/sync-lifecycle.ts`, `platform/index.ts`, `accessories/{light,cover,gate,scenario}-accessory.ts` and the new `accessories/communication-failure.ts`.

## Config keys

### New: `mqtt.commands`
| | |
|---|---|
| Type | boolean |
| Default | `true` (unchanged behaviour) |
| Runtime | on when absent or `true`; off for `false`; **any other value (`"false"`, `0`, `null`, ...) turns commands off** and is reported at startup. Unlike the other on/off keys (invalid → default), an invalid value here gives the safe value: whoever wrote `"false"` meant to switch commands off |
| Schema position | inside the `mqtt` object, right after `mqtt.enabled` (it only matters when MQTT is on); same `condition` as the other `mqtt.*` fields |
| Title EN | Accept commands over MQTT |
| Title IT | Accetta comandi via MQTT |
| Description EN | When off, the bridge only publishes device state and availability: it does not subscribe to the `.../set` topics, so nothing published on the broker can operate lights, covers, thermostats or scenarios. Leave it on only if the broker requires authentication and its ACL limits who can write the `.../set` topics. |
| Description IT | Se disattivato il bridge pubblica solo lo stato dei dispositivi e la disponibilità: non si iscrive ai topic `.../set`, quindi nulla di ciò che viene pubblicato sul broker può comandare luci, tapparelle, termostati o scenari. Lascialo attivo solo se il broker richiede l'autenticazione e il suo ACL limita chi può scrivere sui topic `.../set`. |

No numeric key was added, so `runtime-config-limits.ts` is untouched. No existing key changed.

### New topic: `<topicPrefix>/status` (not a config key; document it)
- Retained, QoS = `mqtt.qos`, always retained (independent of `mqtt.retain`, which applies to state topics).
- Payload while connected: `{"state":"online","panel":"connected"|"disconnected"|"unknown","timestamp":"<ISO>"}`. Payload when the bridge is gone: `{"state":"offline"}` — published at a clean shutdown and registered as the MQTT **last will**, so the broker publishes it also after a crash or a network loss (after the keepalive, 60 s).
- `panel` follows the panel connection as the platform sees it (`SyncLifecycle`: the same events that drive Matter reachability). A panel offline from boot is `disconnected` from the first publish; `unknown` appears only if the bridge is used without the platform.
- Home Assistant: `availability_topic: <prefix>/status`, `availability_template: "{{ value_json.state }}"` (`payload_available: online`).
- **ACL**: a restrictive ACL must let the bridge's MQTT user **write** `<prefix>/status`. Example for mosquitto: `topic write homebridge/klares4/status`. Mosquitto 2 may refuse a CONNECT whose will topic the user cannot write ("Not authorized"); when a CONNECT with the will is refused as "Not authorized" and the CONNECT sent right after without it is accepted, the bridge runs without the will and logs one warning that states exactly that (state publishing keeps working, only the crash detection is lost). The will is tried again every 30 minutes and comes back without a restart once the ACL allows it. A refusal also of the CONNECT without the will is a credentials problem and leaves the will in place.
- The `+/+/state` and `+/+/+/state` filters used by state consumers do not match `<prefix>/status`.

## Changelog (2.3.0)

### Security
- New `mqtt.commands` option. Set it to `false` to publish state only: the bridge no longer subscribes to the `.../set` topics, so nobody who can publish on the broker can operate devices. The default (`true`) keeps commands on; a value that is not `true` or `false` (for example `"false"` typed by hand) also turns commands off, with a warning. (SP-04)
- The MQTT broker password no longer appears in the log when the broker URL starts with a space or has no scheme. The log now shows only `scheme://host:port`, without user or password. (SP-14)
- A broker URL that mqtt.js would read as a different host (no `mqtt://`, a single slash as in `mqtt:/host`, an unescaped `/` or `#` in the password, an unsupported scheme) is refused with a clear error instead of connecting to `localhost:1883` or to a host named after the port. The error names the cause: an invalid port (not a number, 0 or above 65535) or an unescaped `/`, `#`, `?` in the password. (SP-14, SP-23, R8)
- With `roomMapping` enabled, a command on `<prefix>/<room>/<type>/<id>/set` is executed only if the device belongs to that room, so a per-room ACL on the broker really limits what a client can operate. Commands on `<prefix>/<type>/<id>/set` (no room) work as before. The room also tells apart two devices with the same name in different rooms. (SP-06)
- A device excluded with `excludeZones`/`excludeOutputs`/`excludeSensors`/`excludeScenarios`, or hidden by the exposure policy, cannot be commanded over MQTT, also while its accessory is still restored from the HomeKit cache. The bridge asks the platform's own exclusion decision. (SP-09)

### Fixed
- A burst of MQTT commands (an automation in a loop, a misbehaving client) no longer keeps the panel busy for minutes: for each device one command runs and only the newest waits; older waiting commands are dropped, with one warning per burst. (SP-05)
- After a refused connection (wrong password, user not yet created, broker restarting) the bridge keeps retrying instead of stopping until Homebridge is restarted. Retries start after 5 s and back off up to every 60 s. (SP-07)
- A broker that is down no longer writes two log lines every 5 seconds: one error and one warning when it becomes unreachable, a new line only if the error changes, and one line when it reconnects. (SP-07, TD-DOC-02)
- Two devices whose names give the same topic (`Luce Bagno` and `luce bagno`), or a name without letters or digits, no longer overwrite each other's retained state: each of them is published under its device ID (`.../light/light_6/state`), with one warning naming them. Devices that do not collide keep their topic. (SP-10)
- Invalid MQTT commands are refused with a warning that says what is expected, instead of doing nothing silently: arrays, objects without a known key (`{"state":"ON"}`, `{"On":true}`, `{}`), payloads that are not JSON, `{"on":false,"brightness":80}`, `brightness` on a light that is not dimmable. Payloads larger than 4 KB are dropped without being parsed. These warnings are rate limited (one per minute per kind). (SP-15)
- Topic levels and payloads written in the log are quoted and cut to 80 characters: a client can no longer inject fake log lines or 60 kB lines. (SP-15)
- A QoS 1 retransmission of the same command (DUP flag, same packet ID) is not executed twice. (SP-23)
- A `topicPrefix` containing `+` or `#` is refused at startup with an error instead of publishing on invalid topics. (SP-23)
- A command refused by the panel queue or by validation (device not discovered yet, value out of range, arming scenario) is logged as a readable warning instead of a generic error. HomeKit handlers keep the original error as `cause` of the HAP error they throw (HomeKit still sees "communication failure", unchanged), so the MQTT bridge can say why.

### Added
- `<topicPrefix>/status`: retained availability of the bridge (`online`/`offline`, with an MQTT last will) and of the panel connection. (SP-11)
- Zone state payload: new `tampered` field (the panel's tamper flag, also shown on HomeKit as "Tampered"). It is added after `bypassed`; every existing field keeps its name, type, value and order. Like `open`, `armed`, `fault` and `bypassed`, it is always present and is `false` until the panel reports the flag. (PLAT-13)

- Homebridge shutdown after a broker interruption: the bridge publishes `offline`, sends DISCONNECT and closes within 2 seconds even if the broker never confirmed a message sent during the interruption (it used to wait forever, leaving the session open until the process exited). (N1)
- A transient "Not authorized" from the broker no longer disables the MQTT last will until restart with a guessed cause: the will is set aside only when the broker refused the connection with it and accepted the one right after without it, the warning states what was observed, and the will is retried every 30 minutes. (N2)

### Changed
- `mqtt.js` no longer reconnects on its own (`reconnectPeriod: 0`): the plugin schedules the reconnections (backoff 5 s → 60 s). No change for users.
- `{"on":true,"brightness":40}` runs the two steps one after the other (it used to send them in parallel).

## Migration notes
- **ACL**: if the broker has an ACL, allow the plugin's user to write `<topicPrefix>/status` (e.g. `topic write homebridge/klares4/status`). Without it the bridge still connects (if the broker refuses the will, the bridge runs without it, says so once, and tries the will again every 30 minutes), but the availability topic is not written.
- **Room-level command topics with `roomMapping` on**: a command addressed to the wrong room (or to a room-less device through a room topic) is now refused with a warning. Use the right room or the direct topic `<prefix>/<type>/<id>/set`.
- **Colliding names**: devices that shared a state topic move to `.../<type>/<device id>/state`; the shared retained topic is cleared. Consumers reading those devices by name must switch to the ID topic (or give the devices distinct names). At startup a colliding device can be published once on the shared topic before the second device is known; that message is cleared right after.
- **Broker URL**: a URL without `mqtt://`/`mqtts://`/`ws://`/`wss://` (or `tcp`, `tls`, `ssl`) no longer connects; fix it in the settings. A password with `/`, `#`, `?` or `@` should be percent-encoded (`%2F`, `%23`, `%3F`, `%40`), or set in `mqtt.password`.
- Invalid command payloads that used to be ignored silently now produce warnings (rate limited).
- State topics and payloads are unchanged for every device that does not collide, except one added key: `tampered` in the zone payload (golden-value tests pin the payload of each device type and check that every 2.2.0 key keeps its value and order). A consumer that rejects unknown keys must accept it.

## Documentation notes (task L)
- README EN/IT, MQTT section: add `mqtt.commands`; a "MQTT security" subsection: commands are not authenticated by the plugin; use a broker with authentication, an ACL (example below), TLS (`mqtts://`); set `mqtt.commands: false` when only state is needed. There is no option for a custom CA or `rejectUnauthorized` on `mqtts://`: a broker with a self-signed certificate cannot be used (secure default, document it).
- Example ACL (mosquitto), state only: `topic write homebridge/klares4/+/+/state`, `topic write homebridge/klares4/+/+/+/state`, `topic write homebridge/klares4/status`, `topic read homebridge/klares4/#`. With commands: add `topic read` for the `.../set` topics for the plugin user and `topic write` on `homebridge/klares4/<room>/+/+/set` per user/room to confine clients to a room (needs `roomMapping`).
- `mosquitto_pub` examples: show `-u/-P`.
- Credentials in the broker URL take precedence over `mqtt.username`/`mqtt.password` (mqtt.js behaviour); prefer the separate fields.
- Document `<prefix>/status` (payloads, last will, Home Assistant availability example).
- Command payloads accepted per type: light `{"on":bool,"brightness":0-100}`, cover `{"position":0-100}`, thermostat `{"mode":"off|heat|cool|auto","targetTemperature":5-40}`, scenario `{"active":true}`; max 4 KB; unknown extra keys are ignored (debug line); while a command runs only the newest one waits.
- Zone payload: `{"id","name","type","timestamp","open","armed","fault","bypassed","tampered"}`. `tampered` (since 2.3.0) comes from the panel's `T` field (`T` other than `N` → `true`); only resting values were observed on real panels, see `changes/C.md`. As for the other zone flags, `false` also means "not reported yet".
- Name collisions → ID topics (see migration notes). Gate devices publish `{"active":false}` with the generic shape (unchanged, pinned by test; not a real state).
- `SECURITY.md`: mention MQTT (unauthenticated commands, `mqtt.commands`, ACL).
- ARCHITECTURE: `mqtt-bridge/` is now split: `index.ts` (facade `MqttBridge`, accepts an optional 4th argument `MqttBridgeDeps` with an injectable `connect`), `broker-session.ts` (connection: one mqtt.js client per attempt, ended with force when it closes so its unconfirmed publishes are failed; backoff; bounded shutdown), `last-will-policy.ts` (when the will is set aside and retried), `state-publisher.ts` + `state-topic-registry.ts` (state topics, collisions), `command-intake.ts` (retained/DUP/size filter), `command-executor.ts` (validation, one running + one waiting per device), `accessory-index-service.ts` (ID/slug/room lookup, exclusions), `room-resolver.ts`, `command-failure.ts`, `throttled-log.ts`. New public method `MqttBridge.setPanelConnected(connected)`, called through `SyncLifecycleDeps.onPanelConnection`. The platform passes `discoveryService.isDeviceExcluded` as `MqttBridgeDeps.isDeviceExcluded` (single source for exclusions and exposure policy); without it (bridge used standalone) no exclusion check is done beyond the handlers present. `accessories/communication-failure.ts` builds the `HapStatusError` with `cause`. `Lares4Platform.isMatterEligible` now reads only `resolveMatterPolicy` (the arming-scenario check is part of the exposure policy; equivalence pinned by `test/matter-eligibility-single-source.test.js`). In `initializeLares4` the MQTT bridge is now created before `SyncLifecycle.attach`, so the initial "panel not connected" reaches it.

## Points to verify on the field
- With the production broker: that mosquitto accepts the CONNECT with the will on `homebridge/klares4/status` once the ACL allows it, and what it does with the current ACL (refused CONNECT → retry without will + warning, or accepted CONNECT with the will dropped silently).
- That the Prometheus exporter ignores `homebridge/klares4/status` (its filters `+/+/state` and `+/+/+/state` do not match it).

## Other security switches with a permissive default (not changed, for review)
Read with the common rule (invalid value → default): `matterExposure.zones/sensors/scenarios/lights/covers/gates/thermostats` (default `true`: an invalid value exposes the category on Matter). The other security-relevant booleans already default to the safe value (`allowInsecureTls`, `exposePartialArmScenarios`, `generateDebugFile`, `mqtt.enabled` default `false`; `https` default `true`).
