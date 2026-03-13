# WebSocket Protocol

## Transport and Session

- Connection target:
  - HTTPS WSS: `wss://<ip>:443/KseniaWsock/`
  - HTTP WS: `ws://<ip>:80/KseniaWsock/`
- Login command: `CMD=LOGIN`, `PAYLOAD_TYPE=UNKNOWN`, with `PIN`.
- On successful `LOGIN_RES`, plugin stores `ID_LOGIN` and starts initial reads.

## Initial Read Pipeline

The plugin sends:

1. `READ/ZONES`
2. `READ/MULTI_TYPES` (`OUTPUTS`, `BUS_HAS`, `SCENARIOS`)
3. `READ/STATUS_OUTPUTS`
4. `READ/STATUS_BUS_HA_SENSORS`
5. `READ/STATUS_SYSTEM`
6. `READ/PRG_THERMOSTATS`
7. `READ/CFG_THERMOSTATS`
8. `REALTIME/REGISTER` with:
   - `STATUS_ZONES`
   - `STATUS_OUTPUTS`
   - `STATUS_BUS_HA_SENSORS`
   - `STATUS_SYSTEM`
   - `STATUS_TEMPERATURES`
   - `SCENARIOS`

## Routing Logic

- Responses (`*_RES`) are handled by `ProtocolRouter`.
- `READ_RES` payloads update discovery state and caches.
- `REALTIME_RES/REGISTER_ACK` and `REALTIME/CHANGES` both update runtime states.
- `CommandDispatcher` tracks pending commands and ACK timeouts.

## Command Paths

- Lights/covers/gates:
  - `CMD_USR/CMD_SET_OUTPUT`
- Scenarios:
  - `CMD_USR/CMD_EXE_SCENARIO`
- Thermostats:
  - `WRITE_CFG/CFG_ALL` with `CFG_THERMOSTATS` entries
  - ACK expected: `WRITE_CFG_RES`

Legacy thermostat fallback `WRITE/THERMOSTAT` is not used.

## Thermostat-Relevant Payloads

### `CFG_THERMOSTATS`

Persistent thermostat configuration, used for:

- startup target/mode alignment
- non-destructive writes (merge existing entry + patch)

### `STATUS_TEMPERATURES`

Realtime thermostat status, used as authority for:

- current temperature
- target temperature (when valid numeric)
- HVAC mode
- output active state

### `STATUS_OUTPUTS`

Output runtime status. For thermostats this is secondary (activity correlation), not routing authority.

### `PRG_THERMOSTATS`

Structural map (if exposed by firmware):

- thermostat program ID
- linked Domus sensor (`PERIPH.PID`)
- heating/cooling outputs

Used to resolve command routing without heuristics.
