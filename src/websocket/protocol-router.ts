import type { KseniaMessage } from '../types';

export interface ProtocolRouterHandlers {
    onResponseMessage?: (message: KseniaMessage) => void;
    onLoginResponse: (message: KseniaMessage) => void;
    onReadResponse: (message: KseniaMessage) => void;
    onRealtimeResponse: (message: KseniaMessage) => void;
    onStatusUpdate: (message: KseniaMessage) => void;
    onPing?: (message: KseniaMessage) => void;
    onUnhandled?: (message: KseniaMessage) => void;
}

export class ProtocolRouter {
    constructor(private readonly handlers: ProtocolRouterHandlers) {}

    public route(message: KseniaMessage): void {
        if (message.CMD.endsWith('_RES')) {
            this.handlers.onResponseMessage?.(message);
        }

        switch (message.CMD) {
            case 'LOGIN_RES':
                this.handlers.onLoginResponse(message);
                return;
            case 'READ_RES':
                this.handlers.onReadResponse(message);
                return;
            case 'REALTIME_RES':
                this.handlers.onRealtimeResponse(message);
                return;
            case 'REALTIME':
                if (message.PAYLOAD_TYPE === 'CHANGES') {
                    this.handlers.onStatusUpdate(message);
                }
                return;
            case 'STATUS_UPDATE':
                this.handlers.onStatusUpdate(message);
                return;
            case 'PING':
                this.handlers.onPing?.(message);
                return;
            default:
                this.handlers.onUnhandled?.(message);
        }
    }
}
