/**
 * A device or room name as a slug: lower case, spaces as underscores, accents
 * folded, anything else dropped. Used for MQTT topic levels and for the room
 * names derived from a `.ksa` backup, which must agree with each other.
 */
export function createDeviceSlug(deviceName: string): string {
    return deviceName
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[àáâãäå]/g, 'a')
        .replace(/[èéêë]/g, 'e')
        .replace(/[ìíîï]/g, 'i')
        .replace(/[òóôõö]/g, 'o')
        .replace(/[ùúûü]/g, 'u')
        .replace(/[ç]/g, 'c')
        .replace(/[^a-z0-9_]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}
