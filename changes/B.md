# B — Commands

## Config keys

None added or changed. The queue deadline is the existing `commandTimeoutMs` (default 8000 ms, 1000..30000).

## Changelog entries (2.3.0)

### Security
- The PIN is masked in the plugin log whatever it contains and wherever it is: a PIN with quotes or backslashes, a PIN that is a number, a list or an object, a truncated frame, and a payload carried as a JSON string. Every credential-like key is masked the same way (`PIN`, `PIN_CODE`, `USER_PIN`, `PASSWORD`, `CODE`, `TOKEN`, ...). (WS-11)
- The LOGIN frame is no longer written to the log at every (re)connection; with `logLevel: 2` it is logged at debug, masked. (WS-11)
- Commands only reach outputs and scenarios the plugin discovered on the panel with that kind: a command for an output the plugin does not expose (for example through an MQTT topic or a stale cached accessory of an output now hidden by the fail-closed exposure) is refused and nothing is sent to the panel. (WS-01, defense in depth)
- Running a scenario follows the same policy as exposing it, `exposeScenarios` included: a scenario of an unknown category runs only when listed there, ARM/DISARM never run. The refusal says why (arming, partial arming, unknown category) instead of always "arms or disarms the alarm". (WS-02, defense in depth)

### Fixed
- Commands no longer go out late. A command still queued after `commandTimeoutMs` is refused with an error instead of being sent when the panel finally answers the previous one. (WS-04, SP-05)
- Gates and scenarios: pressing again while the previous pulse is still waiting for the panel is refused at once, instead of queueing a second and third pulse that the gate received seconds later. (WS-04)
- Lights, dimmers and covers: when several commands for the same device pile up (a dragged brightness or position slider), only the latest one is sent. The requests it replaces are not errors: they complete together with it, successfully if the panel confirms it and with its error if not, so HomeKit no longer shows "No response" or logs an error for each step of a slider. The number of commands waiting per device is capped. (WS-04, SP-05, COMMS-04)
- A light, dimmer or cover command is confirmed by the panel's realtime state only when the output actually changes to the requested state after the command. A state the output already had, or the late event of an earlier command, no longer counts as a confirmation; a refusal from the panel always wins. Empty or blank positions (`""`, `" "`, `null`) are no longer read as 0, and a malformed status entry no longer throws. (WS-06)
- `NaN`, `Infinity` or a non-number brightness/position, and an on/off that is not a boolean (`"false"`), are refused instead of turning into "close" / "off" / "on". (WS-08)
- A command acknowledged without `RESULT=OK` is a failure for every command that changes something on the panel, and a command sent without any confirmation is reported as an error, never logged as success. (TD-T-05, M58)
- A panel answering with a numeric response ID is now matched to the right command even with several commands pending. (WS-14)

## Migration notes
- No change to config, persisted data, UUIDs or topics.
- Callers that pressed a gate or a scenario repeatedly now get an error for the presses made while the first is pending (HomeKit/Matter show the command as failed). This is intended.
- A queued light, dimmer or cover command can still be sent up to `commandTimeoutMs` (default 8 s) after it was requested, when the previous command for the same device takes that long to be answered; beyond that it is refused. A light may therefore switch on several seconds after the tap on a slow panel. (COMMS-05)
- Panels whose firmware does not acknowledge output commands: a command is confirmed only by a state change seen after it. A command that changes nothing (the light is already on, the cover is already at that position) or sent to an output whose state was never reported now ends in a timeout error, where 2.2.0 reported success. The panels observed so far acknowledge every command, so this applies only to such firmwares. (COMMS-06)
- Right after Homebridge starts, before the first synchronization has listed the devices, commands from cached accessories are refused ("not a … discovered on the panel") instead of being sent blind.

## Documentation notes
- ARCHITECTURE / websocket-protocol: command lifecycle `requested → queued (per-device policy, deadline = commandTimeoutMs, depth cap 4) → sent → acknowledged (RESULT=OK) | state-confirmed (transition) | rejected | timed out`. Policies: `latest-wins` for lights/dimmers/covers, `reject-while-busy` for gates/scenarios, `serial` default.
- State confirmation: valid only as a transition observed after registration; the realtime event of an earlier command on the same output (acknowledged or timed out, for up to one command timeout) is attributed to that command, not to the next one; numbers compared strictly.
- Command timing (COMMS-05): a queued command for a light, dimmer or cover is sent at most `commandTimeoutMs` after the request (it waits for the previous command of the same device), otherwise it is refused with "still queued after N ms". Requests replaced by a newer one for the same device are never sent and complete with the newer one.
- Firmwares without ACK (COMMS-06): confirmation by state needs a transition seen after the command; idempotent commands and outputs with no reported state end in a timeout on such firmwares.
- Troubleshooting: messages "Command for gate_N not sent: a previous command for it is still in progress", "... replaced by a newer command", "... still queued after N ms", "Command refused: X is not a light discovered on the panel".

## Reusable primitive (for task D and task H)

`CommandDispatcher.enqueueDeviceCommand(key, command, options?)` (in `websocket/command-dispatcher.ts`, implementation in `websocket/device-command-queue.ts`):
- `key`: any string, one command at a time per key (task D can use e.g. `thermostat-cfg:<cfgId>`).
- `options.policy`: `'serial'` (default) | `'latest-wins'` | `'reject-while-busy'`.
- `options.maxWaitMs`: a waiting command older than this is refused (`reason: 'expired'`) and never runs. No deadline when omitted.
- `options.maxDepth`: waiting commands allowed behind the running one (default `DeviceCommandQueue.DEFAULT_MAX_DEPTH` = 4); more are refused (`'queue-full'`).
- `latest-wins`: replaced requests are not rejected any more; they settle with the outcome of the command that replaced them (oldest first, the command really sent last, so a caller that caches the value it asked for ends with the value sent).
- Refusals are `CommandQueueRejectedError` (a `RetryableKlaresError`) with `reason`: `'busy' | 'expired' | 'queue-full'` (`'superseded'` stays in the type for compatibility but is no longer produced; task H's executor may keep handling it).
- `queuedCommandCount(key)`; `rejectAllPendingCommands(error)` (socket closed, heartbeat reset) and `clearCommandQueues()` (disconnect) also refuse every waiting command, so nothing queued is sent on the next socket.
- Called without options (as `thermostat-command-service.ts` does today) it behaves as before except for the depth cap of 4.

## Decisions to confirm (user)
- **Queue deadline = `commandTimeoutMs` (COMMS-05).** A light, dimmer or cover command waiting behind an unanswered one may be sent up to that long after the request. Alternative: a shorter deadline than the ACK timeout (fewer late commands, more refusals while a slider is dragged on a slow panel).
- **Confirmation by transition only (COMMS-06).** On a firmware without ACK, an idempotent command or one to an output with no reported state times out instead of succeeding. Alternative: accept a matching state with no known prior state (reopens the stale-event false success of WS-06).
- **Replaced requests complete with the newer command (COMMS-04).** The UI shows success for intermediate slider steps once the final value is confirmed; none of them is sent.
- **Scenario categories are never pruned** (COMMS-10): a scenario deleted on the panel keeps its category in `scenarioCategoryById` for the session, but it is no longer a discovered device after the next sync, and the command guard refuses it (tested end to end). Pruning the map, if wanted, belongs to the discovery round (`message-service.ts` / `discovered-device.ts`, task C).
