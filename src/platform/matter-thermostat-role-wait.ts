import type { Logger } from 'homebridge';
import type { KseniaDevice } from '../types';

/**
 * Holds the Matter registration of a thermostat while its output role is
 * still a guess from the output name (`status.outputRolePending`: the panel
 * lists the outputs before the thermostat programs, and without a `.ksa`
 * backup the first login has no program data yet). The attribute set of a
 * Thermostat endpoint follows the role, so registering on the guess would
 * mean replacing the endpoint moments later.
 *
 * The hold ends when the client clears the flag (programs read, or refused by
 * the panel) and the next update registers the device; or, if the programs
 * never come (connection lost meanwhile), after `waitMs`, when the device
 * registers with the role from its name. A role that changes after that is
 * handled by replacing the endpoint.
 */
export class ThermostatRoleWait {
    private readonly waiting = new Map<string, { device: KseniaDevice; timer: NodeJS.Timeout }>();
    private readonly expired = new Set<string>();

    constructor(
        private readonly waitMs: number,
        private readonly log: Logger,
        private readonly onExpired: (device: KseniaDevice) => void,
    ) {}

    /** `true` when the registration of `device` must wait; the latest snapshot is kept. */
    public hold(device: KseniaDevice): boolean {
        if (device.type !== 'thermostat' || device.status?.outputRolePending !== true || this.expired.has(device.id)) {
            this.release(device.id);
            return false;
        }
        const entry = this.waiting.get(device.id);
        if (entry) {
            entry.device = device;
            return true;
        }
        const timer = setTimeout(() => {
            const latest = this.waiting.get(device.id)?.device ?? device;
            this.waiting.delete(device.id);
            this.expired.add(device.id);
            this.log.info(`[Matter] ${latest.name}: no thermostat program data from the panel; registering with the role from the output name`);
            this.onExpired(latest);
        }, this.waitMs);
        timer.unref?.();
        this.waiting.set(device.id, { device, timer });
        this.log.debug(`[Matter] ${device.name}: waiting for the thermostat programs before registering`);
        return true;
    }

    private release(id: string): void {
        const entry = this.waiting.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.waiting.delete(id);
    }
}
