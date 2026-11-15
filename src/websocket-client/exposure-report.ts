import type { Logger } from 'homebridge';
import type { HiddenDevice, WebSocketClientState } from './types';

/**
 * Devices the exposure policy keeps out of `state.devices`, by the device ID
 * they would have had (`light_7`, `scenario_4`): what a cached accessory of
 * an earlier version is matched against.
 */
export function hiddenDevices(state: WebSocketClientState): Map<string, HiddenDevice> {
    state.hiddenByExposurePolicy ??= new Map();
    return state.hiddenByExposurePolicy;
}

const OUTPUT_PREFIXES: readonly string[] = ['light', 'cover', 'gate', 'thermostat'];
const DEVICE_ID = /^([a-z]+)_(.+)$/;

/**
 * True when the latest discovery read hid the panel output or scenario this
 * device ID names, whatever output prefix an earlier version gave it.
 */
export function isHiddenByExposurePolicy(state: WebSocketClientState, deviceId: string): boolean {
    const match = DEVICE_ID.exec(deviceId);
    if (!match) return false;
    const [, prefix = '', panelId = ''] = match;
    const kind = prefix === 'scenario' ? 'scenario' : OUTPUT_PREFIXES.includes(prefix) ? 'output' : undefined;
    if (!kind) return false;
    for (const device of state.hiddenByExposurePolicy?.values() ?? []) {
        if (device.kind === kind && device.panelId === panelId) return true;
    }
    return false;
}

/**
 * Replaces the hidden devices of one kind with those of the latest read. A
 * device the policy now hides leaves `state.devices` too (its category
 * changed on the panel since an earlier read): it must not stay commandable.
 */
export function replaceHiddenDevices(
    state: WebSocketClientState,
    kind: HiddenDevice['kind'],
    hidden: readonly HiddenDevice[],
): void {
    const registry = hiddenDevices(state);
    for (const [deviceId, device] of registry) {
        if (device.kind === kind) registry.delete(deviceId);
    }
    for (const device of hidden) {
        registry.set(device.deviceId, device);
        const prefixes = device.kind === 'output' ? OUTPUT_PREFIXES : ['scenario'];
        for (const prefix of prefixes) state.devices.delete(`${prefix}_${device.panelId}`);
    }
}

interface ReadFindings {
    hidden: HiddenDevice[];
    /** Opt-in rows that change nothing, with the reason. */
    ignoredOptIns: string[];
    /** Exposed scenarios whose panel PIN flag is not `N`. */
    pinFlagged: string[];
}

function emptyFindings(): ReadFindings {
    return { hidden: [], ignoredOptIns: [], pinFlagged: [] };
}

function describe(device: HiddenDevice): string {
    const mode = device.mode ? `, mode ${device.mode}` : '';
    return `${device.kind} ${device.panelId} "${device.name}" (category ${device.category || 'none'}${mode})`;
}

/**
 * Collects what one discovery read hid, plus opt-in rows with no effect and
 * PIN-flagged scenarios, and logs it as a single warning listing the exact
 * config lines that would expose each hidden device. A reconnect that finds
 * the same situation logs it at debug level only.
 */
export class ExposureReport {
    private outputs = emptyFindings();
    private scenarios = emptyFindings();
    private pending = false;
    private lastWarning: string | undefined;

    constructor(private readonly log: Logger) {}

    public recordOutputs(findings: ReadFindings): void {
        this.outputs = findings;
        this.pending = true;
    }

    public recordScenarios(findings: ReadFindings): void {
        this.scenarios = findings;
        this.pending = true;
    }

    /** Logs the findings recorded since the last flush, if any. */
    public flush(): void {
        if (!this.pending) return;
        this.pending = false;
        const warning = this.compose();
        if (warning === undefined) {
            this.lastWarning = undefined;
            return;
        }
        if (warning === this.lastWarning) {
            this.log.debug('Exposure policy: same hidden devices as the previous discovery');
            return;
        }
        this.lastWarning = warning;
        this.log.warn(warning);
    }

    private compose(): string | undefined {
        const optInable = [
            ...this.outputs.hidden,
            ...this.scenarios.hidden.filter((device) => device.optInAllowed),
        ];
        const ignored = [...this.outputs.ignoredOptIns, ...this.scenarios.ignoredOptIns];
        const pinFlagged = this.scenarios.pinFlagged;
        if (optInable.length === 0 && ignored.length === 0 && pinFlagged.length === 0) return undefined;

        const parts: string[] = [];
        if (optInable.length > 0) {
            parts.push(
                `Exposure policy: ${optInable.length} device(s) of a category the plugin does not recognize are not `
                + 'exposed (HomeKit, Matter, MQTT) and cannot be controlled:',
                ...optInable.map((device) => `  - ${describe(device)}`),
                'Expose only what is safe to switch from voice assistants, scenes and automations: '
                + 'to expose one, add its entry to the platform config (plugin settings or config.json):',
                ...configLines(optInable),
            );
        }
        if (ignored.length > 0) {
            parts.push('Exposure policy: these opt-in entries have no effect:', ...ignored.map((line) => `  - ${line}`));
        }
        if (pinFlagged.length > 0) {
            parts.push(
                'Exposed scenarios the panel flags with a PIN requirement (check that running them '
                + 'without a code is intended):',
                ...pinFlagged.map((line) => `  - ${line}`),
            );
        }
        return parts.join('\n');
    }
}

function configLines(devices: readonly HiddenDevice[]): string[] {
    const outputs = devices
        .filter((device) => device.kind === 'output')
        .map((device) => JSON.stringify({ outputId: device.panelId, exposeAs: 'light' }));
    const scenarios = devices
        .filter((device) => device.kind === 'scenario')
        .map((device) => JSON.stringify({ scenarioId: device.panelId }));
    const lines: string[] = [];
    if (outputs.length > 0) lines.push(`  "exposeOutputs": [${outputs.join(', ')}]`);
    if (scenarios.length > 0) lines.push(`  "exposeScenarios": [${scenarios.join(', ')}]`);
    return lines;
}

export type { ReadFindings };
