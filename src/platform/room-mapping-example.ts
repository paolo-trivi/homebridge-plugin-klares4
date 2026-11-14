import type { DeviceListItem, DevicesList } from './types';

interface ExampleDevice {
    deviceId: string;
    deviceName: string;
}

/** Which slice of each list the example puts in each room: just enough to show the shape. */
const EXAMPLE_ROOMS: Array<{ roomName: string; slices: Array<[keyof Omit<DevicesList, 'lastUpdated'>, number, number]> }> = [
    { roomName: 'sala', slices: [['sensors', 0, 2], ['outputs', 0, 1]] },
    { roomName: 'cucina', slices: [['outputs', 1, 3]] },
    { roomName: 'camera', slices: [['zones', 0, 1], ['outputs', 3, 4]] },
];

const MAX_EXAMPLE_DEVICES_PER_ROOM = 3;

function devicesForRoom(devicesList: DevicesList, slices: Array<[keyof Omit<DevicesList, 'lastUpdated'>, number, number]>): ExampleDevice[] {
    return slices
        .flatMap(([category, from, to]) => devicesList[category].slice(from, to))
        .map((device: DeviceListItem) => ({ deviceId: device.fullId, deviceName: device.name }))
        .slice(0, MAX_EXAMPLE_DEVICES_PER_ROOM);
}

function availableDevices(items: DeviceListItem[]): Array<{ id: string; name: string; type: string }> {
    return items.map((device) => ({ id: device.fullId, name: device.name, type: device.type }));
}

/**
 * The text of `klares4-room-mapping-example.json`. It depends only on the
 * device list (no timestamp), so an unchanged list gives an identical file
 * and the caller can tell there is nothing to write.
 */
export function buildRoomMappingExample(devicesList: DevicesList): string {
    return JSON.stringify({
        roomMapping: {
            enabled: false,
            rooms: EXAMPLE_ROOMS.map(({ roomName, slices }) => ({ roomName, devices: devicesForRoom(devicesList, slices) })),
        },
        _note: 'This is an example file. Modify roomName and devices as needed.',
        _availableDevices: {
            outputs: availableDevices(devicesList.outputs),
            zones: availableDevices(devicesList.zones),
            sensors: availableDevices(devicesList.sensors),
            scenarios: availableDevices(devicesList.scenarios),
        },
    }, null, 2);
}
