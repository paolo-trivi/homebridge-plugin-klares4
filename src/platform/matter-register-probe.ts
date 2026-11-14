import type { API, Logger } from 'homebridge';
import type { MatterRegistration } from './matter-registration-recovery';
import { isMatterAccessoryQueryable } from './matter-registration-recovery';

/**
 * Probe-based settle: poll `api.matter.getAccessoryState` after registration
 * until the endpoint actually answers, then resolve. Replaces the legacy fixed
 * 2-second `setTimeout` which caused early `updateAccessoryState` calls to
 * fail with "Accessory not registered or missing endpoint".
 *
 * Backoff: initialDelayMs, x1.5 per poll, capped at maxDelayMs, up to
 * `timeoutMs` total. Returns `true` if the endpoint became queryable, `false`
 * if the timeout elapsed first (caller decides recovery).
 */
export interface ProbeOptions {
    timeoutMs: number;
    initialDelayMs: number;
    maxDelayMs: number;
}

export async function probeUntilQueryable(
    api: API,
    log: Logger,
    fmtErr: (err: unknown) => string,
    reg: MatterRegistration,
    options: ProbeOptions,
): Promise<boolean> {
    const deadline = Date.now() + options.timeoutMs;
    let delay = options.initialDelayMs;

    while (Date.now() < deadline) {
        if (await isMatterAccessoryQueryable(api, log, fmtErr, reg)) return true;
        await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
        delay = Math.min(options.maxDelayMs, Math.round(delay * 1.5));
    }
    // One last probe at the deadline boundary.
    return isMatterAccessoryQueryable(api, log, fmtErr, reg);
}

/**
 * What the runtime has shown about `registerPlatformAccessories`. Homebridge
 * 2.4 emits the registration and resolves at once (the endpoint is built
 * later), 2.5 resolves once the registration is over, failed or not. The
 * plugin does not read the version: an endpoint that did not exist before the
 * call and answers as soon as the call resolves proves that the call waits.
 * From then on an endpoint that does not answer right after its register will
 * not appear later, and the probe budget is the short one.
 */
export class RegisterSettlement {
    private registerWaits = false;

    constructor(private readonly api: API) {}

    /** True when the endpoint answers; call it just before a register. */
    public async exists(uuid: string): Promise<boolean> {
        try {
            return await this.api.matter?.getAccessoryState(uuid, 'bridgedDeviceBasicInformation') !== undefined;
        } catch {
            return false;
        }
    }

    /** Records what a register of an endpoint that did not exist before has shown. */
    public async observeNewEndpoint(uuid: string): Promise<void> {
        if (!this.registerWaits && await this.exists(uuid)) this.registerWaits = true;
    }

    public get registerIsSettled(): boolean {
        return this.registerWaits;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
