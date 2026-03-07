import type {
    KseniaCover,
    KseniaDevice,
    KseniaLight,
    KseniaScenario,
    KseniaSensor,
    KseniaThermostat,
    KseniaZone,
    DeviceStatePayload,
    LightStatePayload,
    CoverStatePayload,
    ThermostatStatePayload,
    SensorStatePayload,
    ZoneStatePayload,
    ScenarioStatePayload,
} from '../types';

export function createDeviceStatePayload(device: KseniaDevice): DeviceStatePayload {
    const basePayload = {
        id: device.id,
        name: device.name,
        type: device.type,
        timestamp: new Date().toISOString(),
    };

    switch (device.type) {
        case 'light': {
            const light = device as KseniaLight;
            const lightPayload: LightStatePayload = {
                ...basePayload,
                on: light.status?.on ?? false,
                brightness: light.status?.brightness ?? 0,
                dimmable: light.status?.dimmable ?? false,
            };
            return lightPayload;
        }

        case 'cover': {
            const cover = device as KseniaCover;
            const coverPayload: CoverStatePayload = {
                ...basePayload,
                position: cover.status?.position ?? 0,
                state: cover.status?.state ?? 'stopped',
            };
            return coverPayload;
        }

        case 'thermostat': {
            const thermostat = device as KseniaThermostat;
            const thermostatPayload: ThermostatStatePayload = {
                ...basePayload,
                currentTemperature: thermostat.currentTemperature ?? 0,
                targetTemperature: thermostat.targetTemperature ?? 20,
                mode: thermostat.mode ?? 'off',
                humidity: thermostat.humidity,
            };
            return thermostatPayload;
        }

        case 'sensor': {
            const sensor = device as KseniaSensor;
            const sensorPayload: SensorStatePayload = {
                ...basePayload,
                sensorType: sensor.status?.sensorType ?? 'unknown',
                value: sensor.status?.value ?? 0,
                unit: sensor.status?.unit ?? '',
            };
            return sensorPayload;
        }

        case 'zone': {
            const zone = device as KseniaZone;
            const zonePayload: ZoneStatePayload = {
                ...basePayload,
                open: zone.status?.open ?? false,
                armed: zone.status?.armed ?? false,
                fault: zone.status?.fault ?? false,
                bypassed: zone.status?.bypassed ?? false,
            };
            return zonePayload;
        }

        case 'scenario': {
            const scenario = device as KseniaScenario;
            const scenarioPayload: ScenarioStatePayload = {
                ...basePayload,
                active: scenario.status?.active ?? false,
            };
            return scenarioPayload;
        }

        default: {
            const unknownPayload: ScenarioStatePayload = {
                ...basePayload,
                active: false,
            };
            return unknownPayload;
        }
    }
}
