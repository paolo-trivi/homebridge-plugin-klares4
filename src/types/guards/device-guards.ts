import type {
    KseniaCover,
    KseniaDevice,
    KseniaLight,
    KseniaScenario,
    KseniaSensor,
    KseniaThermostat,
    KseniaZone,
} from '../device.types';

export function isKseniaLight(device: KseniaDevice): device is KseniaLight {
    return device.type === 'light';
}

export function isKseniaCover(device: KseniaDevice): device is KseniaCover {
    return device.type === 'cover';
}

export function isKseniaThermostat(device: KseniaDevice): device is KseniaThermostat {
    return device.type === 'thermostat';
}

export function isKseniaSensor(device: KseniaDevice): device is KseniaSensor {
    return device.type === 'sensor';
}

export function isKseniaZone(device: KseniaDevice): device is KseniaZone {
    return device.type === 'zone';
}

export function isKseniaScenario(device: KseniaDevice): device is KseniaScenario {
    return device.type === 'scenario';
}
