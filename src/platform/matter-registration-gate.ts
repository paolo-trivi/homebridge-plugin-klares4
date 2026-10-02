/**
 * One Matter registration in flight per device ID.
 *
 * `registerAccessory` awaits the explicit-thermostat-recovery unregister before
 * it records the registration. A status update arriving in that window found
 * no registration and registered the same UUID a second time; Homebridge 2.4
 * rejects the duplicate (the error is only logged) and the recovery ended on
 * the wrong endpoint. A caller that arrives while a registration is in flight
 * now waits for it and then takes the normal update path.
 */
export class MatterRegistrationGate {
    private readonly inFlight = new Map<string, Promise<void>>();

    public run(id: string, register: () => Promise<void>, onJoin: () => Promise<void>): Promise<void> {
        const pending = this.inFlight.get(id);
        if (pending) return pending.then(onJoin, onJoin);
        const operation = register();
        const release = (): void => {
            if (this.inFlight.get(id) === operation) this.inFlight.delete(id);
        };
        this.inFlight.set(id, operation);
        // Side branch, so the caller settles on the same tick as the bare register.
        operation.then(release, release);
        return operation;
    }
}
