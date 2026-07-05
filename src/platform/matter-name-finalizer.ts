import type { API, Logger, MatterAccessory } from 'homebridge';
import type { KseniaDevice } from '../types';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterNameService } from './matter-name-service';
import { logNameTable } from './matter-name-map';

export interface NameFinalizeDeps {
    api: API;
    log: Logger;
    nameService: MatterNameService;
    registrations: Map<string, MatterRegistration>;
    recordMetadataChanged: () => void;
    /** Re-register a renamed device (same UUID; registry marks it `[rename]`). */
    registerRenamed: (device: KseniaDevice) => Promise<void>;
    fmtErr: (err: unknown) => string;
}

/**
 * Two-phase naming, phase 2 — runs when the initial WS sync is complete and
 * the full device set is known. Batch-recomputes the authoritative name-map,
 * persists it, logs the final name → uuid table (with a WARN guard on
 * case-insensitive duplicates), and re-registers only the accessories whose
 * live displayName differs from the map — rare: devices added/renamed on the
 * panel, or the very first boot without a persisted map.
 *
 * The targeted refresh is an unregister + register with the same UUID:
 * matter.js/Homebridge 2 has no safe in-place metadata update
 * (`updatePlatformAccessories` drops live endpoints), and the same-UUID
 * re-register is the pattern already proven by the stale-endpoint recovery
 * path — rooms/automations survive because the endpoint identity is
 * UUID-derived.
 */
export async function finalizeMatterNameMap(devices: KseniaDevice[], deps: NameFinalizeDeps): Promise<void> {
    const { entries, duplicates, persisted } = deps.nameService.finalize(devices);
    logNameTable(deps.log, entries.values(), duplicates);
    if (persisted) deps.log.info(`[Matter] name-map updated and persisted (${entries.size} devices)`);

    for (const device of devices) {
        const target = entries.get(device.id)?.name;
        const reg = deps.registrations.get(device.id);
        if (!target || !reg || reg.registeredDisplayName === target) continue;
        if (reg.status !== 'registered') {
            deps.log.debug(`[Matter] name refresh deferred for ${device.id} (status=${reg.status}); next register uses "${target}"`);
            continue;
        }

        deps.log.info(`[Matter] name refresh: "${reg.registeredDisplayName}" -> "${target}" (uuid=${device.id})`);
        deps.recordMetadataChanged();
        try {
            await deps.api.matter!.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
                { UUID: device.id } as MatterAccessory,
            ]);
        } catch (err) {
            deps.log.debug(`[Matter] pre-rename unregister for ${device.id} returned: ${deps.fmtErr(err)}`);
        }
        deps.registrations.delete(device.id);
        await deps.registerRenamed(device);
    }
}
