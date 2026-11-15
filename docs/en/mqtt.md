# MQTT Bridge

The bridge publishes the state of every exposed device, publishes its own availability, and (unless you turn it off) receives commands. It is optional and off by default (`mqtt.enabled`).

## Configuration

| Key | Notes |
|---|---|
| `mqtt.enabled` | Turns the bridge on |
| `mqtt.commands` | Default `true`. `false`: the bridge never subscribes to the `.../set` topics, so nothing published on the broker can operate a device. A value that is neither `true` nor `false` (`"false"` typed by hand, for example) also turns commands off, with a warning at startup |
| `mqtt.broker` | URL with a scheme: `mqtt://`, `mqtts://`, `ws://`, `wss://` (`tcp://`, `tls://`, `ssl://` also work). A URL that mqtt.js would read as another host (no scheme, `mqtt:/host`, an unescaped `/` or `#` in the password) is refused with an error instead of connecting somewhere else |
| `mqtt.port` | Overrides the port of the URL. Empty: the URL's port, or the protocol default (1883, 8883) |
| `mqtt.username`, `mqtt.password` | Preferred to credentials in the URL, which take precedence when both are set. A password with `/`, `#`, `?` or `@` must be percent-encoded in the URL |
| `mqtt.clientId` | Unique per Homebridge instance on the same broker; empty for a random one |
| `mqtt.topicPrefix` | Default `homebridge/klares4`; cannot contain `+` or `#` (refused at startup) |
| `mqtt.qos` | 0, 1 (default) or 2 |
| `mqtt.retain` | Default `true`, for state topics |

The log shows the broker only as `scheme://host:port`, without user or password.

## Topics

| Topic | Direction | Content |
|---|---|---|
| `<prefix>/<type>/<slug>/state` | plugin → broker | Retained state of a device |
| `<prefix>/<room>/<type>/<slug>/state` | plugin → broker | The same with `roomMapping` on |
| `<prefix>/<type>/<id or slug>/set` | broker → plugin | Commands (only with `mqtt.commands` on) |
| `<prefix>/<room>/<type>/<id>/set` | broker → plugin | The same with `roomMapping` on: executed only if the device belongs to that room |
| `<prefix>/status` | plugin → broker | Availability, always retained |

- `<type>` is `light`, `cover`, `thermostat`, `sensor`, `zone` or `scenario`. Devices without a room (the panel's own temperatures) use the room-less topic.
- The slug is made from the device name. Two devices that give the same slug (`Bathroom Light` and `bathroom light`), or a name with no letters or digits, are each published under their device ID (`.../light/light_6/state`) with one warning; the shared retained topic is cleared. Devices that do not collide keep their topic. Consumers that read a colliding device by name must switch to the ID topic (or give the devices distinct names).
- Room names containing `+`, `#` or `/` are published with `_` in their place.
- Devices excluded with the `exclude*` lists or hidden by the exposure policy are not published (retained topics left by earlier versions are not cleared: delete them on the broker).
- The filters `+/+/state` and `+/+/+/state` used by state consumers do not match `<prefix>/status`.

## State Payloads

Every payload carries `id`, `name`, `type` and an ISO `timestamp`, plus:

| Type | Fields |
|---|---|
| light | `on`, `brightness` (0-100), `dimmable` |
| cover | `position` (0-100), `state` (`opening`, `closing`, `stopped`) |
| thermostat | `currentTemperature`, `targetTemperature`, `mode` (`off`, `heat`, `cool`, `auto`), `humidity` when known |
| sensor | `sensorType`, `value`, `unit` |
| zone | `open`, `armed`, `fault`, `bypassed`, `tampered` |
| scenario | `active` |

A gate publishes the generic shape `{"active": false}`, which is not a real state. `tampered` (added in 2.3.0, after `bypassed`; every earlier field keeps its name, value and order) is the tamper flag of the zone; like the other zone flags it is `false` until the panel reports it.

## Availability: `<prefix>/status`

Retained, QoS `mqtt.qos`, whatever `mqtt.retain` says.

- While the bridge runs: `{"state":"online","panel":"connected","timestamp":"<ISO time>"}`, where `panel` is `connected`, `disconnected` or `unknown` (the connection to the panel as the platform sees it; `unknown` only if the bridge is used without the platform). A panel that is offline from boot reads `disconnected` from the first message.
- When the bridge is gone: `{"state":"offline"}`. It is published at a clean shutdown and registered as the MQTT **last will**, so the broker publishes it after a crash or a network loss (after the keep-alive, 60 seconds).

Home Assistant:

```yaml
availability_topic: homebridge/klares4/status
availability_template: "{{ value_json.state }}"
payload_available: online
```

## Commands

Publish with `retain=false`: a retained command is ignored with a warning (the broker would replay it at every reconnect); clear it with an empty retained message to that topic. Payloads are JSON objects of at most 4 KB; unknown extra keys are ignored.

| Device | Payload |
|---|---|
| Light | `{"on": true, "brightness": 80}`; `brightness` only on a dimmable light; `{"on": false, "brightness": 80}` is refused; the two steps of `{"on": true, "brightness": 40}` run one after the other |
| Cover | `{"position": 50}` (0-100) |
| Thermostat | `{"mode": "off\|heat\|cool\|auto", "targetTemperature": 22}`; a setpoint outside `temperatureDefaults.min`/`max` is refused with a warning |
| Scenario | `{"active": true}` |

- For each device one command runs and only the newest waits; older waiting commands are dropped, with one warning per burst.
- Invalid commands are refused with a warning that says what is expected (arrays, objects without a known key such as `{"state":"ON"}` or `{}`, text that is not JSON, `brightness` on a light that is not dimmable). These warnings are rate limited. Payloads larger than 4 KB are dropped without being parsed.
- A QoS 1 retransmission of the same command (DUP flag, same packet ID) is not executed twice.
- A command the panel queue or the validation refuses (device not discovered yet, value out of range, an arming scenario) is logged as a readable warning.
- Topic levels and payloads written in the log are quoted and cut to 80 characters.

```bash
mosquitto_pub -h 192.168.1.100 -u mqtt_user -P mqtt_password -t "homebridge/klares4/light/light_1/set" -m '{"on": true, "brightness": 80}'
```

## Connection Behavior

- Nothing is queued while the broker is unreachable; the latest state of every device is republished on reconnect.
- After a refused connection (wrong password, user not created yet, broker restarting) the bridge keeps retrying: after 5 s, backing off up to every 60 s. mqtt.js itself does not reconnect (`reconnectPeriod: 0`); the plugin schedules the retries.
- A broker that is down writes one error and one warning when it becomes unreachable, a new line only if the error changes, and one line when it reconnects.
- When a device is renamed while the plugin runs, the old retained state topic is cleared. Topics left over from before a restart are not known to the plugin.

## Security

**The plugin does not authenticate commands.** Whoever can publish on a `.../set` topic can operate lights, covers, thermostats and scenarios, and the PIN you stored does the rest.

1. Use a broker that requires authentication, an ACL that limits who can write the `.../set` topics, and TLS (`mqtts://`) when the broker is not on the same host. There is no option for a custom CA or for skipping verification on `mqtts://`: a broker with a self-signed certificate cannot be used.
2. If you only need state, set `mqtt.commands` to `false`.
3. With `roomMapping` on, confine each client to a room with an ACL on `<prefix>/<room>/+/+/set`.

Example Mosquitto ACL, state only:

```
user klares4
topic write homebridge/klares4/+/+/state
topic write homebridge/klares4/+/+/+/state
topic write homebridge/klares4/status

user reader
topic read homebridge/klares4/#
```

With commands on, add `topic read` for `homebridge/klares4/+/+/set` and `homebridge/klares4/+/+/+/set` for the plugin's user, and `topic write homebridge/klares4/<room>/+/+/set` for each client that may command that room.

**The plugin's user must be able to write `<prefix>/status`.** Mosquitto 2 may refuse a CONNECT whose last-will topic the user cannot write (`Not authorized`). When a CONNECT with the last will is refused as `Not authorized` and the CONNECT sent right after without it is accepted, the bridge runs without the last will, logs one warning that says exactly that, and keeps publishing state; only the crash detection is lost. The last will is tried again every 30 minutes, so it comes back without a restart once the ACL allows it. If the CONNECT without the last will is refused too, the cause is the credentials and the last will stays in place.
