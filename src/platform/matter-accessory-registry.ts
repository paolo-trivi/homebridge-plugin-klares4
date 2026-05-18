import type { API, Logger } from 'homebridge';
import type { MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { KseniaWebSocketClient } from '../websocket-client';
import { deviceToMatterAccessory, toCentidegrees, clampCentidegrees, domainModeToMatterMode } from './matter-device-mapper';

export class MatterAccessoryRegistry {
    private readonly cachedUUIDs: Set<string> = new Set();
    private readonly registeredUUIDs: Set<string> = new Set();
    private activeDiscoveredUUIDs: Set<string> = new Set();

    constructor(
        private readonly api: API,
        private readonly log: Logger,
        private readonly getWsClient: () => KseniaWebSocketClient | undefined,
    ) {}

    public get isEnabled(): boolean {
        return !!this.api.matter;
    }

    public configureCachedAccessory(accessory: MatterAccessory): void {
        this.cachedUUIDs.add(accessory.UUID);
        this.log.debug(`[Matter] Cached accessory: ${accessory.displayName} (${accessory.UUID})`);
    }

    public startDiscoveryCycle(): void {
        this.activeDiscoveredUUIDs = new Set();
    }

    public async addOrUpdateAccessory(device: KseniaDevice): Promise<void> {
        if (!this.api.matter) return;

        const matterAccessory = deviceToMatterAccessory(device, {
            api: this.api,
            log: this.log,
            getWsClient: this.getWsClient,
        });

        if (!matterAccessory) {
            return;
        }

        this.activeDiscoveredUUIDs.add(device.id);

        if (this.registeredUUIDs.has(device.id)) {
            // Already registered — update state
            await this.pushStateUpdate(device);
            return;
        }

        if (this.cachedUUIDs.has(device.id)) {
            // Already restored from cache by HB2 — handlers re-attached. Just track and push state.
            this.log.debug(`[Matter] Restored from cache: ${device.name}`);
            this.registeredUUIDs.add(device.id);
            await this.pushStateUpdate(device);
            return;
        }

        this.log.info(`[Matter] Registering new accessory: ${device.name} (${device.type})`);
        try {
            await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [matterAccessory]);
            this.registeredUUIDs.add(device.id);
            this.log.info(`[Matter] Registered: ${device.name}`);
        } catch (err) {
            this.log.warn(`[Matter] Failed to register ${device.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    public async updateAccessoryState(device: KseniaDevice): Promise<void> {
        if (!this.api.matter) return;
        if (!this.registeredUUIDs.has(device.id)) return;
        await this.pushStateUpdate(device);
    }

    public async pruneStaleAccessories(): Promise<void> {
        if (!this.api.matter) return;

        for (const uuid of this.registeredUUIDs) {
            if (!this.activeDiscoveredUUIDs.has(uuid)) {
                this.log.info(`[Matter] Removing stale accessory: ${uuid}`);
                try {
                    await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
                        { UUID: uuid } as MatterAccessory,
                    ]);
                    this.registeredUUIDs.delete(uuid);
                    this.cachedUUIDs.delete(uuid);
                } catch (err) {
                    this.log.warn(`[Matter] Failed to unregister ${uuid}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
    }

    private async pushStateUpdate(device: KseniaDevice): Promise<void> {
        const matter = this.api.matter!;
        const uuid = device.id;

        try {
            switch (device.type) {
                case 'light':
                    await matter.updateAccessoryState(uuid, 'onOff', { onOff: device.status.on });
                    if (device.status.dimmable && device.status.brightness !== undefined) {
                        await matter.updateAccessoryState(uuid, 'levelControl', {
                            currentLevel: Math.round((device.status.brightness / 100) * 254),
                        });
                    }
                    break;

                case 'cover': {
                    const matterPos = Math.round((100 - (device.status.position ?? 0)) * 100);
                    await matter.updateAccessoryState(uuid, 'windowCovering', {
                        currentPositionLiftPercent100ths: matterPos,
                        targetPositionLiftPercent100ths: matterPos,
                    });
                    break;
                }

                case 'thermostat': {
                    const current = device.currentTemperature ?? 21;
                    const target = device.targetTemperature ?? 21;
                    const mode = device.mode ?? 'heat';
                    const HEAT_MIN = 700;
                    const HEAT_MAX = 3000;
                    // HeatingOnly profile: only Off/Heat are valid SystemMode values to keep coherence
                    // with controlSequenceOfOperation=HeatingOnly set at registration time.
                    const safeMode = mode === 'off' ? 'off' : 'heat';
                    await matter.updateAccessoryState(uuid, 'thermostat', {
                        localTemperature: clampCentidegrees(toCentidegrees(current)),
                        occupiedHeatingSetpoint: Math.max(HEAT_MIN, Math.min(HEAT_MAX, toCentidegrees(target))),
                        systemMode: domainModeToMatterMode(safeMode),
                    });
                    break;
                }

                case 'sensor': {
                    const val = device.status.value;
                    switch (device.status.sensorType) {
                        case 'temperature':
                            await matter.updateAccessoryState(uuid, 'temperatureMeasurement', {
                                measuredValue: clampCentidegrees(toCentidegrees(val)),
                            });
                            break;
                        case 'humidity':
                            await matter.updateAccessoryState(uuid, 'relativeHumidityMeasurement', {
                                measuredValue: Math.round(Math.max(0, Math.min(100, val)) * 100),
                            });
                            break;
                        case 'light':
                            await matter.updateAccessoryState(uuid, 'illuminanceMeasurement', {
                                measuredValue: val <= 0 ? 0 : Math.max(1, Math.min(65534, Math.round(10000 * Math.log10(val) + 1))),
                            });
                            break;
                        case 'motion':
                            await matter.updateAccessoryState(uuid, 'occupancySensing', {
                                occupancy: { occupied: val > 0 },
                            });
                            break;
                        case 'contact':
                            await matter.updateAccessoryState(uuid, 'booleanState', {
                                stateValue: val === 0,
                            });
                            break;
                    }
                    break;
                }

                case 'zone':
                    await matter.updateAccessoryState(uuid, 'booleanState', {
                        stateValue: !device.status.open,
                    });
                    break;

                case 'scenario':
                    await matter.updateAccessoryState(uuid, 'onOff', {
                        onOff: device.status.active,
                    });
                    break;

                case 'gate':
                    await matter.updateAccessoryState(uuid, 'onOff', {
                        onOff: device.status.on,
                    });
                    break;
            }
        } catch (err) {
            this.log.debug(`[Matter] State update error for ${uuid}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}

