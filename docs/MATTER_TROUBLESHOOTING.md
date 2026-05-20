# Matter Troubleshooting

Reference guide for diagnosing Matter-related issues with `homebridge-plugin-klares4`.

---

## mDNS and network interface diagnostics

### Symptoms

- Matter pairing intermittent or fails outright
- Matter bridge visible from one controller but not another
- Boot log warning: `Detected another IPv4 mDNS stack running on this host`
- Matter bound to `eno1` but VLAN interface `eno1.50` not used
- Apple Home / Google Home / Alexa can't discover the bridge after a reset

### Root cause summary

Matter uses mDNS (Multicast DNS, UDP port 5353) for device discovery and commissioning.
If a second mDNS stack is already running on the host (Avahi, mDNSResponder, Bonjour, or
another Docker container using host networking), the two stacks compete and Matter
commissioning can fail or behave intermittently.

Additionally, **Matter.js 0.17 / Homebridge 2** binds to a single network interface for
mDNS. If the host has multiple interfaces (e.g. `eno1` for LAN and `eno1.50` for a
management VLAN), only the one chosen by Matter.js at startup will be advertised.

---

### Checks

#### 1. Conflicting mDNS responders

Look for:

```bash
systemctl status avahi-daemon
# or
ps aux | grep -E 'avahi|mDNSResponder|bonjour'
```

If Avahi is running alongside Homebridge on the same host network namespace, it will claim
UDP 5353 and generate the `Detected another IPv4 mDNS stack` warning.

**Options:**

- Run Homebridge in its own network namespace (dedicated VM, host-network Docker container
  with Avahi disabled inside the container).
- Disable Avahi if it is not needed for other services: `systemctl disable --now avahi-daemon`.
- If Avahi is required (e.g. for printer sharing), see if it can be restricted to specific
  interfaces so that Homebridge/Matter.js can own the Matter interface.

#### 2. Firewall — UDP 5353

Matter discovery requires multicast UDP on port 5353 to be open on all relevant interfaces:

```bash
# iptables (Linux)
iptables -L INPUT -v -n | grep 5353

# ufw
ufw status | grep 5353
```

Add a rule if missing:

```bash
ufw allow 5353/udp
```

#### 3. Network interface selection

Matter.js selects the interface for mDNS automatically at startup (typically the default
route interface). If the Homebridge host has multiple interfaces and the Matter bridge
should be reachable on a specific VLAN, verify that the controller (phone, hub) is on the
same subnet as the interface Matter.js chose.

```bash
# Check which interface Matter.js selected (look for the line in Homebridge logs):
# "Matter network interface: eno1"
# or check the default route:
ip route show default
```

If traffic must flow over `eno1.50` instead of `eno1`, consider moving the default route
or ensuring the controller is on the same VLAN as `eno1`.

> **Note:** This plugin does **not** force a specific network interface. Forcing interfaces
> is not officially supported by Homebridge 2 / Matter.js 0.17 and could break future
> updates.

#### 4. Same VLAN / subnet

Matter commissioning requires the controller and the Homebridge host to be on the same
Layer-2 segment (or at minimum reachable via multicast-forwarding). VLANs that block
multicast traffic will prevent discovery.

Verify with a simple ping to the mDNS multicast address:

```bash
# From the controller's network segment (or a host on the same VLAN):
ping -c 3 224.0.0.251          # IPv4 mDNS multicast
ping6 -c 3 ff02::fb%<iface>    # IPv6 mDNS multicast
```

---

### Notes

| Item | Detail |
|---|---|
| Matter.js version | 0.17.0-alpha.x (shipped with Homebridge 2.0.x) |
| mDNS interface | Single interface, chosen automatically at startup |
| Plugin responsibility | None — this plugin does not configure network interfaces |
| Known limitation | If the host has `eno1` + `eno1.50`, only `eno1` will be advertised |
| Workaround | Ensure controller and Homebridge are on the same physical VLAN |

---

## Thermostat — No handler registered

### Symptom

```
No handler registered for thermostat_21.thermostat.occupiedHeatingSetpointChange
```

### Cause

Plugin version < 2.1.3 only registered the `setpointRaiseLower` command handler.
Homebridge 2 / Matter controllers that write attributes directly (e.g. Apple Home when
the user drags the setpoint slider) invoke the attribute-change handlers instead.

### Fix

Upgrade to plugin version ≥ 2.1.3. All four thermostat handlers are now registered:

| Handler | Trigger |
|---|---|
| `setpointRaiseLower` | Relative adjust (+/−) from a controller |
| `occupiedHeatingSetpointChange` | Direct heating setpoint write |
| `occupiedCoolingSetpointChange` | Direct cooling setpoint write (cooling-capable zones only) |
| `systemModeChange` | Mode change (Off / Heat / Cool / Auto) |

---

## Thermostat fallback to TemperatureSensor

### Symptom

```
Thermostat registered as TemperatureSensor fallback: thermostat_21
```

### Cause

matter.js 0.17 `presetTypes` validation bug. Fixed in plugin 2.1.x via the bitmap
workaround in `matter-thermostat-mapper.ts`. If you still see this after upgrading,
check the build is up to date (`npm run build` in the plugin directory).

---

## General diagnostic commands

```bash
# View Homebridge logs (Docker example)
docker logs smarthome-homebridge-1 --tail 200 -f | grep -i matter

# Check plugin version
cat /path/to/node_modules/homebridge-plugin-klares4/package.json | grep '"version"'

# Restart Homebridge (Docker)
docker restart smarthome-homebridge-1
```
