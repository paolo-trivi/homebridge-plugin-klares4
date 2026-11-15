# Security Policy

## Supported Versions

Security fixes go to the latest release of the current minor line, and only to it. Everything older: update.

| Version | Supported |
| ------- | --------- |
| 2.3.x (including release candidates while they are the newest) | ✅ |
| 2.2.x and older | ❌ — update to 2.3.x |
| 1.x | ❌ |

2.3.0 closes several security findings of earlier versions (outputs and scenarios exposed without a recognized category, PIN handling in logs and debug files, MQTT hardening). If you run 2.2.x, update.

## Reporting a Vulnerability

Please **do not** open a public issue for a security vulnerability.

1. **GitHub Private Vulnerability Reporting** (preferred): open the repository's **Security** tab and choose **Report a vulnerability**. The report stays private between you and the maintainer.
2. **Email**: [paolo.trivisonno@gmail.com](mailto:paolo.trivisonno@gmail.com) with "SECURITY" in the subject.

### What to include

- A description of the vulnerability and its potential impact.
- Steps to reproduce it (a synthetic configuration is enough: **do not send your PIN, your IP address, or a debug file you have not read**; a debug file contains the names of your devices and the state of your alarm system, see below).
- A suggested fix, if you have one.
- How you would like to be credited.

### Response timeline

- **Acknowledgment**: within 48 hours.
- **Initial assessment**: within 5 business days.
- **Status updates**: weekly until resolved.
- **Fix timeline**: depends on severity; critical issues first.

### Disclosure

- Disclosure timing is coordinated with the reporter.
- Fixes are released as soon as possible, and a GitHub security advisory is published after the fix is available.
- Reporters are credited unless they ask for anonymity.

## Security Considerations

This plugin controls an alarm system. What to know before you run it:

- **The PIN is stored in clear text in Homebridge's `config.json`.** Use a dedicated panel user with only the rights this plugin needs, never your installer or master code, and protect the Homebridge storage folder (permissions, backups). The plugin never writes the PIN to the log, to MQTT or to the debug file.
- **Exposure is fail-closed.** The plugin exposes a device only if it recognizes it. Outputs of an unrecognized category (sirens, alarm bridges, indicators, door strikes, irrigation) and scenarios of an unknown category are not exposed and cannot be controlled; you opt in one by one (`exposeOutputs`, `exposeScenarios`). Opt in only what is safe to operate from voice assistants, scenes and automations: a light "turn off all the lights" acts on every exposed light. Arming and disarming scenarios are **never** exposed, and partial arming only with `exposePartialArmScenarios`. Anyone who can operate a switch can run the scenario with the stored PIN, without a PIN prompt.
- **`allowInsecureTls` turns off certificate verification** and allows legacy TLS renegotiation. It is on only for the JSON value `true`, off by default. The panel uses a self-signed certificate and old TLS settings, so many installations need it: enable it only on a trusted local network. Without it, a man in the middle on the LAN cannot read or alter your commands.
- **MQTT commands are not authenticated by the plugin.** Anyone who can publish on the `.../set` topics of the broker can operate lights, covers, thermostats and scenarios. Use a broker with authentication, an ACL that limits who can write the command topics, and TLS (`mqtts://`); set `mqtt.commands` to `false` if you only need state. The ACL must let the plugin's user write `<prefix>/status`. The broker password is never logged. See [`docs/en/mqtt.md`](docs/en/mqtt.md).
- **The debug file is confidential.** It contains the names of your devices and the state of your alarm system. PINs, account data, serial numbers and the home position are masked, nothing else is. It is written readable by its owner only (`0600`). Do not attach it to a public issue; send it privately. Delete debug files written by 2.2.x and earlier, which contain the home position and account description, before sharing anything.
- **Privacy: no telemetry.** The plugin makes no connection to third parties. Its only outbound connections are the WebSocket to your panel and, if you turn it on, your MQTT broker.
- **Untrusted input.** A `.ksa` backup is treated as untrusted (numeric IDs only, names cut, a size limit); frames from the panel are checked (shape, CRC, size) before use; MQTT command payloads are validated, size-limited and rate-limited in the log.
- **Release integrity.** Releases are published only by the `Release Publish` workflow, from a pushed `v*` tag, with npm provenance. The tarball is built in a job that runs no dependency code except the TypeScript compiler, the tests run in another job, and the job that publishes runs no repository or dependency code. The tagged commit must be on `main`. A stable release must follow a release candidate published by the same workflow from an earlier commit of the same line, with the same lockfile and dependencies: its code may differ from the release candidate only by changes made in the repository after it.

## Security Best Practices

1. **Network**: keep Homebridge, the panel and the MQTT broker on a trusted network segment; do not expose the panel to the internet.
2. **Updates**: keep the plugin updated, in place (never reinstall it or regenerate the Matter child bridge).
3. **Access control**: limit access to the Homebridge configuration and storage folder; use a dedicated panel user for the plugin.
4. **Monitoring**: watch the log for the `Exposure policy` warning after an update, for repeated login failures, and for MQTT warnings about invalid commands.

Thank you for helping keep homebridge-plugin-klares4 secure.
