import WebSocket from 'ws';
import type { Logger } from 'homebridge';

export class WsTransport {
    constructor(private readonly log: Logger) {}

    public async send(ws: WebSocket | undefined, rawMessage: string): Promise<void> {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }

        await new Promise<void>((resolve, reject) => {
            ws.send(rawMessage, (error?: Error): void => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    public ping(ws: WebSocket | undefined): void {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            ws.ping();
        } catch (error: unknown) {
            this.log.error(
                'Heartbeat ping error:',
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    public closeGracefully(ws: WebSocket | undefined, code: number, reason: string): void {
        if (!ws) {
            return;
        }
        try {
            ws.close(code, reason);
        } catch {
            ws.terminate();
        }
    }

    public terminateIfNotClosed(ws: WebSocket | undefined, delayMs: number): void {
        if (!ws) {
            return;
        }
        setTimeout((): void => {
            if (ws.readyState !== WebSocket.CLOSED) {
                ws.terminate();
            }
        }, delayMs);
    }
}
