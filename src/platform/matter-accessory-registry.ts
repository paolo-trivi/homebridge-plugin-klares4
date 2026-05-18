import type { API, Logger } from 'homebridge';
import type { MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { KseniaWebSocketClient } from '../websocket-client';
import { deviceToMatterAccessory, toCentidegrees, clampCentidegrees, domainModeToMatterMode } from './matter-device-mapper';

export class MatterAccessoryRegistry {
    private readonly cachedUUIDs: Set<string> = new Set();
    private readonly registeredUUIDs: Set<string> = new Set();
    private readonly failedUUIDs: Set<string> = new Set();
    // Tracks when each UUID was registered — state updates are deferred until the IPC commit
    // has had time to complete (HB2 registerPlatformAccessories is fire-and-forget on the API side).
    private readonly registeredAt: Map<string, number> = new Map();
    private static readonly REGISTER_SETTLE_MS = 2000;
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
        // Skip devices whose registration has previously failed — retrying floods logs with
        // identical Behavior errors and never recovers within a single process lifetime.
        if (this.failedUUIDs.has(device.id)) return;

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
            // Already registered — push state, but only if past the IPC settle window.
            const registeredAt = this.registeredAt.get(device.id) ?? 0;
            if (Date.now() - registeredAt >= MatterAccessoryRegistry.REGISTER_SETTLE_MS) {
                await this.pushStateUpdate(device);
            }
            return;
        }

        const fromCache = this.cachedUUIDs.has(device.id);
        if (fromCache) {
            this.log.debug(`[Matter] Restoring cached accessory: ${device.name}`);
        } else {
            this.log.info(`[Matter] Registering new accessory: ${device.name} (${device.type})`);
        }

        try {
            await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [matterAccessory]);
            this.registeredUUIDs.add(device.id);
            this.registeredAt.set(device.id, Date.now());
            this.log.info(`[Matter] Registered: ${device.name}`);
            // Do NOT push state immediately — registerPlatformAccessories is fire-and-forget on the
            // API side (emits an event, doesn't await commit). The initial clusters payload in the
            // MatterAccessory already carries the current state, so the next status update will
            // catch up after REGISTER_SETTLE_MS.
        } catch (err) {
            this.failedUUIDs.add(device.id);
            this.log.warn(`[Matter] Failed to register ${device.name} — will not retry this session: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    public async updateAccessoryState(device: KseniaDevice): Promise<void> {
        if (!this.api.matter) return;
        // Skip devices that we've already failed to register — avoids log spam.
        if (this.failedUUIDs.has(device.id)) return;
        // Lazy registration: an HAP status update can arrive before the WS "discovered" callback,
        // especially for accessories already in HAP cache. Register on the fly so we don't miss any.
        if (!this.registeredUUIDs.has(device.id)) {
            await this.addOrUpdateAccessory(device);
            return;
        }
        // Skip state pushes during the IPC settle window — the registration event hasn't been
        // processed by the Matter server yet, so updateAccessoryState would fail with "not found".
        const registeredAt = this.registeredAt.get(device.id) ?? 0;
        if (Date.now() - registeredAt < MatterAccessoryRegistry.REGISTER_SETTLE_MS) {
            return;
        }
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
                    const HEAT_MIN = 700, HEAT_MAX = 3000;
                    const COOL_MIN = 1600, COOL_MAX = 3200;
                    const DEADBAND_CENTI = 250;
                    const heatingSetpoint = Math.max(HEAT_MIN, Math.min(HEAT_MAX, toCentidegrees(target)));
                    const coolingSetpoint = Math.max(COOL_MIN, Math.min(COOL_MAX, heatingSetpoint + DEADBAND_CENTI));
                    await matter.updateAccessoryState(uuid, 'thermostat', {
                        localTemperature: clampCentidegrees(toCentidegrees(current)),
                        occupiedHeatingSetpoint: heatingSetpoint,
                        occupiedCoolingSetpoint: coolingSetpoint,
                        unoccupiedHeatingSetpoint: heatingSetpoint,
                        unoccupiedCoolingSetpoint: coolingSetpoint,
                        systemMode: domainModeToMatterMode(mode),
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

