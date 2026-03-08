import type { Service } from 'homebridge';

export function getCachedCharacteristicNumber(
    service: Service,
    characteristic: Parameters<Service['getCharacteristic']>[0],
    min: number,
    max: number,
): number | undefined {
    const cachedCharacteristic = service.getCharacteristic(characteristic);
    if (!cachedCharacteristic) {
        return undefined;
    }
    const value = cachedCharacteristic.value;
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(min, Math.min(max, value));
    }
    return undefined;
}
