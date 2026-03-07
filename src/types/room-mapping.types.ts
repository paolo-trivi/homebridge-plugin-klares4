export interface RoomDevice {
    deviceId: string;
    deviceName?: string;
}

export interface RoomConfig {
    roomName: string;
    devices?: RoomDevice[];
}

export interface RoomMappingConfig {
    enabled: boolean;
    rooms?: RoomConfig[];
}
