import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from 'homebridge';

import { isOutputLikeDevice } from '../device-id';
import type { KseniaDevice } from '../types';
import type { DiscoveryService } from './discovery-service';
import type { PlatformLifecycleService } from './platform-lifecycle-service';
import type { DeviceListItem, DevicesList, Lares4Config } from './types';

interface DeviceListServiceOptions {
    log: Logger;
    storagePath: string;
    config: Lares4Config;
    discoveryService: DiscoveryService;
    lifecycleService: PlatformLifecycleService;
}

export class DeviceListService {
    private readonly devicesFilePath: string;

    constructor(private readonly options: DeviceListServiceOptions) {
        this.devicesFilePath = path.join(options.storagePath, 'klares4-devices.json');
    }

    public saveDevicesList(discoveredDevices: Iterable<KseniaDevice>): void {
        try {
            const devicesList = this.buildDevicesList(discoveredDevices);
            const serializedDevices = JSON.stringify(devicesList, null, 2);

            void fs.promises
                .writeFile(this.devicesFilePath, serializedDevices, 'utf8')
                .then((): void => {
                    const count =
                        devicesList.outputs.length +
                        devicesList.zones.length +
                        devicesList.sensors.length +
                        devicesList.scenarios.length;
                    this.options.log.debug(`Devices list saved: ${count} devices`);
                })
                .catch((error: unknown): void => {
                    this.options.log.error(
                        'Error saving devices list:',
                        error instanceof Error ? error.message : String(error),
                    );
                });

            const summaryDelay = this.options.config.devicesSummaryDelay ?? 2000;
            this.options.lifecycleService.scheduleSummary((): void => {
                this.printDevicesSummary(devicesList);
            }, summaryDelay);
        } catch (error: unknown) {
            this.options.log.error(
                'Error saving devices list:',
                error instanceof Error ? error.message : String(error),
            );
        }
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
        this.options.log.info('');
        this.options.log.info('========== AVAILABLE DEVICES ==========');
        this.options.log.info('Use the following IDs to exclude devices or configure MQTT rooms:');
        this.options.log.info('');

        if (devicesList.outputs.length > 0) {
            this.options.log.info('OUTPUTS (Lights, Covers, Thermostats):');
            devicesList.outputs.forEach((device: DeviceListItem): void => {
                const typeLabel =
                    device.type === 'thermostat'
                        ? 'THERM'
                        : device.type === 'light'
                            ? 'LIGHT'
                            : 'COVER';
                this.options.log.info(
                    `   ID: ${device.fullId.padEnd(20)} - [${typeLabel}] ${device.name}`,
                );
            });
            this.options.log.info('');
        }

        if (devicesList.zones.length > 0) {
            this.options.log.info('ZONES (Security Sensors):');
            devicesList.zones.forEach((device: DeviceListItem): void => {
                this.options.log.info(`   ID: ${device.fullId.padEnd(20)} - [ZONE] ${device.name}`);
            });
            this.options.log.info('');
        }

        if (devicesList.sensors.length > 0) {
            this.options.log.info('SENSORS (Temperature, Humidity, Light):');
            devicesList.sensors.forEach((device: DeviceListItem): void => {
                let typeLabel = 'SENSOR';
                if (device.name.includes('Temperatura')) {
                    typeLabel = 'TEMP';
                } else if (device.name.includes('Umidita')) {
                    typeLabel = 'HUM';
                } else if (device.name.includes('Luminosita')) {
                    typeLabel = 'LUX';
                }
                this.options.log.info(
                    `   ID: ${device.fullId.padEnd(20)} - [${typeLabel}] ${device.name}`,
                );
            });
            this.options.log.info('');
        }

        if (devicesList.scenarios.length > 0) {
            this.options.log.info('SCENARIOS (Automations):');
            devicesList.scenarios.forEach((device: DeviceListItem): void => {
                this.options.log.info(
                    `   ID: ${device.fullId.padEnd(20)} - [SCENE] ${device.name}`,
                );
            });
            this.options.log.info('');
        }

        this.options.log.info('Full list saved to: ' + this.devicesFilePath);
        this.options.log.info('Use these IDs in configuration to exclude devices');
        this.options.log.info('Or to configure MQTT rooms in Homebridge UI');
        this.options.log.info('================================================');
        this.options.log.info('');

        this.generateRoomMappingExample(devicesList);
    }

    private generateRoomMappingExample(devicesList: DevicesList): void {
        try {
            const examplePath = path.join(
                this.options.storagePath,
                'klares4-room-mapping-example.json',
            );

            const exampleConfig = {
                roomMapping: {
                    enabled: false,
                    rooms: [
                        {
                            roomName: 'sala',
                            devices: this.getExampleDevicesForRoom(devicesList, 'sala'),
                        },
                        {
                            roomName: 'cucina',
                            devices: this.getExampleDevicesForRoom(devicesList, 'cucina'),
                        },
                        {
                            roomName: 'camera',
                            devices: this.getExampleDevicesForRoom(devicesList, 'camera'),
                        },
                    ],
                },
                _note: 'This is an example file. Modify roomName and devices as needed.',
                _availableDevices: {
                    outputs: devicesList.outputs.map((d: DeviceListItem) => ({
                        id: d.fullId,
                        name: d.name,
                        type: d.type,
                    })),
                    zones: devicesList.zones.map((d: DeviceListItem) => ({
                        id: d.fullId,
                        name: d.name,
                        type: d.type,
                    })),
                    sensors: devicesList.sensors.map((d: DeviceListItem) => ({
                        id: d.fullId,
                        name: d.name,
                        type: d.type,
                    })),
                    scenarios: devicesList.scenarios.map((d: DeviceListItem) => ({
                        id: d.fullId,
                        name: d.name,
                        type: d.type,
                    })),
                },
            };

            const serializedExample = JSON.stringify(exampleConfig, null, 2);
            void fs.promises
                .writeFile(examplePath, serializedExample, 'utf8')
                .then((): void => {
                    this.options.log.info(`Room mapping example created: ${examplePath}`);
                })
                .catch((error: unknown): void => {
                    this.options.log.error(
                        'Error creating example file:',
                        error instanceof Error ? error.message : String(error),
                    );
                });
        } catch (error: unknown) {
            this.options.log.error(
                'Error creating example file:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private getExampleDevicesForRoom(
        devicesList: DevicesList,
        roomName: string,
    ): Array<{ deviceId: string; deviceName: string }> {
        const devices: Array<{ deviceId: string; deviceName: string }> = [];

        switch (roomName) {
            case 'sala': {
                const salaDevices = [
                    ...devicesList.sensors.slice(0, 2),
                    ...devicesList.outputs.slice(0, 1),
                ];
                salaDevices.forEach((device: DeviceListItem): void => {
                    devices.push({
                        deviceId: device.fullId,
                        deviceName: device.name,
                    });
                });
                break;
            }
            case 'cucina': {
                const cucinaDevices = [...devicesList.outputs.slice(1, 3)];
                cucinaDevices.forEach((device: DeviceListItem): void => {
                    devices.push({
                        deviceId: device.fullId,
                        deviceName: device.name,
                    });
                });
                break;
            }
            case 'camera': {
                const cameraDevices = [
                    ...devicesList.zones.slice(0, 1),
                    ...devicesList.outputs.slice(3, 4),
                ];
                cameraDevices.forEach((device: DeviceListItem): void => {
                    devices.push({
                        deviceId: device.fullId,
                        deviceName: device.name,
                    });
                });
                break;
            }
        }

        return devices.slice(0, 3);
    }
}
