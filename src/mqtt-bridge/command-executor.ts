import type { Logger } from 'homebridge';
import type {
    MqttCoverCommand,
    MqttLightCommand,
    MqttScenarioCommand,
    MqttThermostatCommand,
} from '../types';
import {
    isMqttCoverCommand,
    isMqttLightCommand,
    isMqttScenarioCommand,
    isMqttThermostatCommand,
    unknownMqttCommandKeys,
    type MqttCommandDeviceType,
} from '../types';
import type { AccessoryHandler } from '../platform';
import { domainModeToHomeKitTarget } from '../thermostat-mode';
import { toErrorMessage } from '../errors';
import { logText } from '../mqtt/log-text';
import { logCommandFailure } from './command-failure';
import { ThrottledWarnings } from './throttled-log';

/** Commands are a few dozen bytes; anything larger is not parsed. */
export const MAX_COMMAND_PAYLOAD_BYTES = 4096;

interface CommandExecutorDeps {
    log: Logger;
    findAccessory: (deviceType: string, deviceIdentifier: string, room?: string) => AccessoryHandler | null;
    warnings?: ThrottledWarnings;
}

type Job = () => Promise<void>;

/** One command running and at most one waiting, per device and type. */
interface DeviceSlot {
    pending?: Job;
    supersededWarned: boolean;
}

const COMMAND_TYPES: readonly MqttCommandDeviceType[] = ['light', 'cover', 'thermostat', 'scenario'];

function isCommandType(deviceType: string): deviceType is MqttCommandDeviceType {
    return (COMMAND_TYPES as readonly string[]).includes(deviceType);
}

/**
 * Turns an MQTT command into calls on the HAP accessory handler, the same
 * path HomeKit uses. Commands for one device never pile up: while one runs,
 * the newest waits and every older waiting one is dropped, so a publisher in
 * a loop cannot keep the panel busy after it stops.
 */
export class CommandExecutor {
    private readonly slots = new Map<string, DeviceSlot>();
    private readonly warnings: ThrottledWarnings;

    constructor(private readonly deps: CommandExecutorDeps) {
        this.warnings = deps.warnings ?? new ThrottledWarnings(deps.log);
    }

    public executeCommand(deviceType: string, deviceIdentifier: string, payload: string, room?: string): void {
        try {
            this.accept(deviceType, deviceIdentifier, payload, room);
        } catch (error: unknown) {
            this.deps.log.error('MQTT: Command execution error:', toErrorMessage(error));
        }
    }

    private accept(deviceType: string, deviceIdentifier: string, payload: string, room?: string): void {
        const target = `${logText(deviceType)}/${logText(deviceIdentifier)}`;
        if (!isCommandType(deviceType)) {
            this.warnings.warn('type', `MQTT: Unsupported device type for commands: ${logText(deviceType)}`);
            return;
        }
        if (Buffer.byteLength(payload) > MAX_COMMAND_PAYLOAD_BYTES) {
            this.warnings.warn('payload', `MQTT: Command for ${target} ignored: payload larger than ${MAX_COMMAND_PAYLOAD_BYTES} bytes`);
            return;
        }
        let command: unknown;
        try {
            command = JSON.parse(payload);
        } catch {
            this.warnings.warn('payload', `MQTT: Command for ${target} ignored: the payload is not JSON`);
            return;
        }

        const accessory = this.deps.findAccessory(deviceType, deviceIdentifier, room);
        if (!accessory) {
            this.warnings.warn('target', `MQTT: Accessory not found - Type: ${logText(deviceType)}, Identifier: ${logText(deviceIdentifier)}`);
            return;
        }
        const job = this.buildJob(deviceType, accessory, command, target);
        if (!job) return;
        if (typeof command === 'object' && command !== null) {
            const ignored = unknownMqttCommandKeys(command, deviceType);
            if (ignored.length > 0) {
                this.deps.log.debug(`MQTT: Command for ${target}: ignoring unknown keys ${ignored.map(logText).join(', ')}`);
            }
        }
        const deviceId = accessory.device?.id ?? deviceIdentifier;
        this.enqueue(`${deviceType}:${deviceId}`, job, target);
    }

    private buildJob(type: MqttCommandDeviceType, accessory: AccessoryHandler, command: unknown, target: string): Job | null {
        const invalid = (): null => {
            this.warnings.warn('payload', `MQTT: Invalid ${type} command payload for ${target}: expected an object with ${this.expectedKeys(type)}`);
            return null;
        };
        switch (type) {
            case 'light':
                return isMqttLightCommand(command) ? this.lightJob(accessory, command, target) : invalid();
            case 'cover':
                return isMqttCoverCommand(command) ? this.coverJob(accessory, command, target) : invalid();
            case 'thermostat':
                return isMqttThermostatCommand(command) ? this.thermostatJob(accessory, command, target) : invalid();
            case 'scenario':
                return isMqttScenarioCommand(command) ? this.scenarioJob(accessory, command, target) : invalid();
        }
    }

    private expectedKeys(type: MqttCommandDeviceType): string {
        const keys: Record<MqttCommandDeviceType, string> = {
            light: '"on" (true/false) and/or "brightness" (0-100)',
            cover: '"position" (0-100)',
            thermostat: '"mode" (off/heat/cool/auto) and/or "targetTemperature" (5-40)',
            scenario: '"active": true',
        };
        return keys[type];
    }

    private enqueue(key: string, job: Job, target: string): void {
        const slot = this.slots.get(key);
        if (!slot) {
            this.slots.set(key, { supersededWarned: false });
            void this.run(key, job, target);
            return;
        }
        if (slot.pending && !slot.supersededWarned) {
            slot.supersededWarned = true;
            this.deps.log.warn(
                `MQTT: Commands for ${target} arrive faster than the panel completes them; ` +
                    'only the latest waiting command is kept, older ones are dropped',
            );
        }
        slot.pending = job;
    }

    private async run(key: string, job: Job, target: string): Promise<void> {
        let next: Job | undefined = job;
        while (next) {
            try {
                await next();
            } catch (error: unknown) {
                logCommandFailure(this.deps.log, `Command for ${target}`, error);
            }
            const slot = this.slots.get(key);
            next = slot?.pending;
            if (slot) slot.pending = undefined;
        }
        this.slots.delete(key);
    }

    private lightJob(accessory: AccessoryHandler, command: MqttLightCommand, target: string): Job | null {
        if (!('setOn' in accessory)) return this.unsupported(target);
        const { on, brightness } = command;
        if (on === false && brightness !== undefined && brightness > 0) {
            this.warnings.warn('payload', `MQTT: Light command for ${target} ignored: "on": false contradicts "brightness": ${brightness}`);
            return null;
        }
        const dimmable = 'setBrightness' in accessory && accessory.device?.status?.dimmable === true;
        if (brightness !== undefined && !dimmable) {
            this.warnings.warn('payload', `MQTT: ${target} is not dimmable: "brightness" ignored`);
            if (on === undefined) return null;
        }
        return async (): Promise<void> => {
            if (on !== undefined) {
                this.deps.log.info(`MQTT: Light requested -> ${on ? 'ON' : 'OFF'}`);
                await accessory.setOn(on);
            }
            if (brightness !== undefined && dimmable && 'setBrightness' in accessory) {
                this.deps.log.info(`MQTT: Brightness requested -> ${brightness}%`);
                await accessory.setBrightness(brightness);
            }
        };
    }

    private coverJob(accessory: AccessoryHandler, command: MqttCoverCommand, target: string): Job | null {
        if (!('setTargetPosition' in accessory)) return this.unsupported(target);
        const position = command.position;
        if (position === undefined) return null;
        return async (): Promise<void> => {
            this.deps.log.info(`MQTT: Cover requested -> ${position}%`);
            await accessory.setTargetPosition(position);
        };
    }

    /**
     * Mode first, setpoint after its acknowledgement: the setpoint is written
     * to the season the mode selects, which is only known once the panel
     * accepted the mode. A failed mode change skips the setpoint.
     */
    private thermostatJob(accessory: AccessoryHandler, command: MqttThermostatCommand, target: string): Job | null {
        if (!('setTargetTemperature' in accessory)) return this.unsupported(target);
        return async (): Promise<void> => {
            if (command.mode !== undefined) {
                this.deps.log.info(`MQTT: Thermostat mode requested -> ${command.mode}`);
                try {
                    await accessory.setTargetHeatingCoolingState(domainModeToHomeKitTarget(command.mode));
                } catch (error: unknown) {
                    logCommandFailure(this.deps.log, 'Thermostat mode', error);
                    if (command.targetTemperature !== undefined) {
                        this.deps.log.warn('MQTT: Thermostat setpoint skipped because the mode change failed');
                    }
                    return;
                }
            }
            if (command.targetTemperature !== undefined) {
                this.deps.log.info(`MQTT: Thermostat requested -> ${command.targetTemperature}C`);
                try {
                    await accessory.setTargetTemperature(command.targetTemperature);
                } catch (error: unknown) {
                    logCommandFailure(this.deps.log, 'Thermostat temperature', error);
                }
            }
        };
    }

    private scenarioJob(accessory: AccessoryHandler, command: MqttScenarioCommand, target: string): Job | null {
        if (!('setOn' in accessory)) return this.unsupported(target);
        if (command.active !== true) {
            this.deps.log.debug(`MQTT: Scenario command for ${target} with "active": false has no effect`);
            return null;
        }
        return async (): Promise<void> => {
            this.deps.log.info('MQTT: Scenario activation requested');
            await accessory.setOn(true);
        };
    }

    private unsupported(target: string): null {
        this.warnings.warn('target', `MQTT: ${target} does not accept this command`);
        return null;
    }
}
