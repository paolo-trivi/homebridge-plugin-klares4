import type { API, Logger, MatterAccessory } from 'homebridge';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';

export type MatterPublicationState =
    | 'requested'
    | 'published-unverified'
    | 'locally-published'
    | 'failed';

function timeoutFromEnvironment(): number {
    const configured = Number(process.env.KLARES4_MATTER_UNREGISTER_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
}

export class MatterTopologyCoordinator {
    private tail: Promise<void> = Promise.resolve();
    private readonly states = new Map<string, MatterPublicationState>();

    constructor(
        private readonly api: API,
        private readonly log: Logger,
    ) {}

    public register(accessory: MatterAccessory): Promise<void> {
        return this.enqueue(accessory.UUID, async () => {
            this.states.set(accessory.UUID, 'requested');
            await this.api.matter!.registerPlatformAccessories(
                PLUGIN_NAME,
                PLATFORM_NAME,
                [accessory],
            );
            this.states.set(accessory.UUID, 'published-unverified');
        });
    }

    public unregister(uuid: string, probeCluster: string): Promise<boolean> {
        return this.enqueue(uuid, async () => {
            this.states.set(uuid, 'requested');
            try {
                await this.api.matter!.unregisterPlatformAccessories(
                    PLUGIN_NAME,
                    PLATFORM_NAME,
                    [{ UUID: uuid } as MatterAccessory],
                );
            } catch (error: unknown) {
                // The API is handed a `{ UUID }` stub with no metadata and can throw
                // while still having removed the endpoint. A rejection is no more
                // proof that the endpoint survived than a resolution is proof that
                // it went away — only the probe below decides.
                this.log.debug(
                    `[Matter] unregister call for ${uuid} threw, deferring to observation: `
                    + `${error instanceof Error ? error.message : String(error)}`,
                );
            }
            this.states.set(uuid, 'published-unverified');
            const absent = await this.waitUntilAbsent(uuid, probeCluster);
            this.states.set(uuid, absent ? 'locally-published' : 'failed');
            return absent;
        });
    }

    public markLocallyPublished(uuid: string): void {
        this.states.set(uuid, 'locally-published');
    }

    public markFailed(uuid: string): void {
        this.states.set(uuid, 'failed');
    }

    public getState(uuid: string): MatterPublicationState | undefined {
        return this.states.get(uuid);
    }

    private enqueue<T>(uuid: string, operation: () => Promise<T>): Promise<T> {
        const result = this.tail.catch((): void => undefined).then(operation);
        this.tail = result.then((): void => undefined, (error: unknown): void => {
            this.states.set(uuid, 'failed');
            this.log.warn(
                `[Matter] topology operation failed for ${uuid}: `
                + `${error instanceof Error ? error.message : String(error)}`,
            );
        });
        return result;
    }

    private async waitUntilAbsent(uuid: string, clusterName: string): Promise<boolean> {
        const deadline = Date.now() + timeoutFromEnvironment();
        let delay = 100;
        while (Date.now() < deadline) {
            try {
                const state = await this.api.matter!.getAccessoryState(uuid, clusterName);
                if (state === undefined) return true;
            } catch {
                // An API error is not proof that the endpoint disappeared.
            }
            await new Promise((resolve): void => { setTimeout(resolve, delay); });
            delay = Math.min(1000, Math.round(delay * 1.5));
        }
        this.log.warn(`[Matter] unregister for ${uuid} was not locally observable before timeout`);
        return false;
    }
}

export function registrationProbeCluster(accessory: MatterAccessory): string {
    return Object.keys(accessory.clusters ?? {})[0] ?? 'bridgedDeviceBasicInformation';
}
