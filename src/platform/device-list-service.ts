import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';

import { writeFileAtomic, writeFileAtomicSync } from '../atomic-file';
import { isOutputLikeDevice } from '../device-id';
import type { KseniaDevice } from '../types';
import type { DiscoveryService } from './discovery-service';
import type { PlatformLifecycleService } from './platform-lifecycle-service';
import { buildRoomMappingExample } from './room-mapping-example';
import type { DeviceListItem, DevicesList, Lares4Config } from './types';
import { toErrorMessage } from '../errors';

interface DeviceListServiceOptions {
    log: Logger;
    storagePath: string;
    config: Lares4Config;
    discoveryService: DiscoveryService;
    lifecycleService: PlatformLifecycleService;
}

const DEVICES_FILE_WRITE_DEBOUNCE_MS = 1000;

/** What identifies a device list, ignoring when it was built. */
function listSignature(devicesList: DevicesList): string {
    return JSON.stringify([devicesList.outputs, devicesList.zones, devicesList.sensors, devicesList.scenarios]);
}

export class DeviceListService {
    private readonly devicesFilePath: string;
    private writeTimer?: NodeJS.Timeout;
    private pendingList?: DevicesList;
    /** The list last handed to `saveDevicesList`: a reconnect that finds the same devices changes nothing. */
    private latestSignature?: string;
    private summarySignature?: string;

    constructor(private readonly options: DeviceListServiceOptions) {
        this.devicesFilePath = path.join(options.storagePath, 'klares4-devices.json');
    }

    /**
     * Called once per discovered device during a sync — the list is rebuilt
     * cheaply every time, but the file write (and the summary) are debounced
     * so a boot with N devices produces one write, not N racing writes. A sync
     * that finds the very same devices (every reconnect) writes and prints nothing.
     */
    public saveDevicesList(discoveredDevices: Iterable<KseniaDevice>): void {
        try {
            const built = this.buildDevicesList(discoveredDevices);
            const signature = listSignature(built);
            if (signature === this.latestSignature) return;
            this.latestSignature = signature;
            this.pendingList = built;

            if (this.writeTimer) {
                clearTimeout(this.writeTimer);
            }
            this.writeTimer = setTimeout((): void => {
                this.writeTimer = undefined;
                this.flushPendingWrite();
            }, DEVICES_FILE_WRITE_DEBOUNCE_MS);
            this.writeTimer.unref?.();

            const summaryDelay = this.options.config.devicesSummaryDelay ?? 2000;
            this.options.lifecycleService.scheduleSummary((): void => {
                this.printDevicesSummary(built);
            }, summaryDelay);
        } catch (error: unknown) {
            this.options.log.error(
                'Error saving devices list:',
                toErrorMessage(error),
            );
        }
    }

    /**
     * Shutdown: cancels the debounce timer and writes a pending list
     * synchronously, so the last discovery is not lost when Homebridge exits.
     */
    public flush(): void {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = undefined;
        }
        const devicesList = this.pendingList;
        if (!devicesList) {
            return;
        }
        this.pendingList = undefined;
        try {
            writeFileAtomicSync(this.devicesFilePath, JSON.stringify(devicesList, null, 2));
        } catch (error: unknown) {
            this.options.log.error(
                'Error saving devices list:',
                toErrorMessage(error),
            );
        }
    }

    private flushPendingWrite(): void {
        const devicesList = this.pendingList;
        if (!devicesList) {
            return;
        }
        this.pendingList = undefined;
        const serializedDevices = JSON.stringify(devicesList, null, 2);

        void writeFileAtomic(this.devicesFilePath, serializedDevices)
            .then((): void => {
                const count =
                    devicesList.outputs.length +
                    devicesList.zones.length +
                    devicesList.sensors.length +
                    devicesList.scenarios.length;
                this.options.log.debug(`Devices list saved: ${count} devices`);
            })
            .catch((error: unknown): void => {
                // Not written: the next sync with the same devices must try again.
                this.latestSignature = undefined;
                this.options.log.error(
                    'Error saving devices list:',
                    toErrorMessage(error),
                );
            });
    }

    private buildDevicesList(discoveredDevices: Iterable<KseniaDevice>): DevicesList {
        const devicesList: DevicesList = {
            zones: [],
            outputs: [],
            sensors: [],
            scenarios: [],
            lastUpdated: new Date().toISOString(),
        };

        for (const device of discoveredDevices) {
            const id = this.options.discoveryService.getNormalizedId(device.id);
            const deviceInfo: DeviceListItem = {
                id,
                name: device.name,
                type: device.type,
                description: device.description || device.name,
                fullId: device.id,
            };

            if (device.type === 'zone') {
                devicesList.zones.push(deviceInfo);
            } else if (isOutputLikeDevice(device)) {
                devicesList.outputs.push(deviceInfo);
            } else if (device.type === 'sensor') {
                devicesList.sensors.push(deviceInfo);
            } else if (device.type === 'scenario') {
                devicesList.scenarios.push(deviceInfo);
            }
        }

        devicesList.zones.sort((a, b) => a.name.localeCompare(b.name));
        devicesList.outputs.sort((a, b) => a.name.localeCompare(b.name));
        devicesList.sensors.sort((a, b) => a.name.localeCompare(b.name));
        devicesList.scenarios.sort((a, b) => a.name.localeCompare(b.name));
        return devicesList;
    }

    private printDevicesSummary(devicesList: DevicesList): void {
        const signature = listSignature(devicesList);
        if (signature === this.summarySignature) return;
        this.summarySignature = signature;

        const log = this.options.log;
        log.info('');
        log.info('========== AVAILABLE DEVICES ==========');
        log.info('"ID" is the device ID used by customNames, matterOverrides and MQTT rooms.');
        log.info('"exclude" is the value to put in excludeOutputs / excludeZones / excludeSensors / excludeScenarios.');
        log.info('');

        const sections: Array<[string, DeviceListItem[]]> = [
            ['OUTPUTS (Lights, Covers, Gates, Thermostats) - excludeOutputs:', devicesList.outputs],
            ['ZONES (Security Sensors) - excludeZones:', devicesList.zones],
            ['SENSORS (Temperature, Humidity, Light) - excludeSensors:', devicesList.sensors],
            ['SCENARIOS (Automations) - excludeScenarios:', devicesList.scenarios],
        ];
        for (const [title, devices] of sections) {
            if (devices.length === 0) continue;
            log.info(title);
            for (const device of devices) {
                // `id` is the prefix-stripped form the exclusion lists compare against.
                log.info(`   ID: ${device.fullId.padEnd(24)} exclude: ${device.id.padEnd(22)} [${summaryLabel(device)}] ${device.name}`);
            }
            log.info('');
        }

        log.info('Full list saved to: ' + this.devicesFilePath);
        log.info('================================================');
        log.info('');

        this.writeRoomMappingExample(devicesList);
    }

    /** Written only when its content differs from what the file already holds. */
    private writeRoomMappingExample(devicesList: DevicesList): void {
        const examplePath = path.join(this.options.storagePath, 'klares4-room-mapping-example.json');
        const content = buildRoomMappingExample(devicesList);
        const log = this.options.log;
        void fs.promises.readFile(examplePath, 'utf8')
            .catch((): undefined => undefined)
            .then(async (existing): Promise<void> => {
                if (existing === content) return;
                await writeFileAtomic(examplePath, content);
                log.info(`Room mapping example ${existing === undefined ? 'created' : 'updated'}: ${examplePath}`);
            })
            .catch((error: unknown): void => {
                log.error('Error creating example file:', toErrorMessage(error));
            });
    }
}

function summaryLabel(device: DeviceListItem): string {
    if (device.type === 'thermostat') return 'THERM';
    if (device.type === 'light') return 'LIGHT';
    if (device.type === 'gate') return 'GATE';
    if (device.type === 'cover') return 'COVER';
    if (device.type === 'zone') return 'ZONE';
    if (device.type === 'scenario') return 'SCENE';
    if (device.fullId.startsWith('sensor_hum_')) return 'HUM';
    if (device.fullId.startsWith('sensor_light_')) return 'LUX';
    return device.fullId.includes('temp') ? 'TEMP' : 'SENSOR';
}
