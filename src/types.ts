export interface KseniaDevice {
    id: string;
    type: 'light' | 'cover' | 'thermostat' | 'sensor' | 'zone' | 'scenario';
    name: string;
    description: string;
    status?: any;
}

export interface KseniaLight extends KseniaDevice {
    type: 'light';
    brightness?: number;
    on: boolean;
    dimmable: boolean;
}

export interface KseniaCover extends KseniaDevice {
    type: 'cover';
    position: number; // 0-100%
    targetPosition?: number;
    state: 'stopped' | 'opening' | 'closing';
}

export interface KseniaThermostat extends KseniaDevice {
    type: 'thermostat';
    currentTemperature: number;
    targetTemperature: number;
    mode: 'off' | 'heat' | 'cool' | 'auto';
    humidity?: number;
}

export interface KseniaSensor extends KseniaDevice {
    type: 'sensor';
    sensorType: 'temperature' | 'humidity' | 'light' | 'motion' | 'contact';
    value: number;
    unit?: string;
}

export interface KseniaZone extends KseniaDevice {
    type: 'zone';
    armed: boolean;
    bypassed: boolean;
    fault: boolean;
    open: boolean;
}

export interface KseniaScenario extends KseniaDevice {
    type: 'scenario';
    active: boolean;
}

// Interfacce per i messaggi WebSocket
export interface KseniaMessage {
    SENDER: string;
    RECEIVER: string;
    CMD: string;
    ID: string;
    PAYLOAD_TYPE: string;
    PAYLOAD: any;
    TIMESTAMP: string;
    CRC_16: string;
}

export interface KseniaWebSocketOptions {
    debug?: boolean;
    reconnectInterval?: number;
    heartbeatInterval?: number;
}

// Interfacce per i dati grezzi dal sistema Ksenia
export interface KseniaOutputData {
    ID: string;
    DES: string;
    TYPE: string;
    STATUS: string;
    POS?: string;
    ENABLED: string;
}

export interface KseniaZoneData {
    ID: string;
    DES: string;
    TYPE: string;
    STATUS: string;
    ENABLED: string;
}

export interface KseniaSensorData {
    ID: string;
    DES: string;
    TYPE: string;
    VALUE: string;
    UNIT?: string;
    ENABLED: string;
} 