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
    if (persisted) {
        const live = [...entries.values()].filter((e) => !e.reserved).length;
        deps.log.info(`[Matter] name-map updated and persisted (${live} devices, ${entries.size - live} reserved)`);
    }

    const deviceById = new Map(devices.map((device) => [device.id, device]));

    // Drive the repair from `registrations`, not from `devices`: a device
    // displaced during phase 1 (the incremental fallback handing its clean
    // name to a higher-priority namesake) may be absent from this sync's
    // eligible set, and iterating `devices` would leave it registered under
    // the old name — a live duplicate of the name the namesake just took,
    // which is exactly what makes voice commands ambiguous.
    for (const [uuid, reg] of [...deps.registrations]) {
        const target = entries.get(uuid)?.name;
        if (!target || reg.registeredDisplayName === target) continue;
        if (reg.status !== 'registered') {
            deps.log.debug(`[Matter] name refresh deferred for ${uuid} (status=${reg.status}); next register uses "${target}"`);
            continue;
        }
        const device = deviceById.get(uuid) ?? (reg.matterAccessory.context?.device as KseniaDevice | undefined);
        if (!device) {
            deps.log.warn(`[Matter] cannot refresh name for ${uuid} ("${reg.registeredDisplayName}" -> "${target}"): device snapshot unavailable`);
            continue;
        }

        deps.log.info(`[Matter] name refresh: "${reg.registeredDisplayName}" -> "${target}" (uuid=${uuid})`);
        deps.recordMetadataChanged();
        try {
            await deps.api.matter!.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
                { UUID: uuid } as MatterAccessory,
            ]);
        } catch (err) {
            deps.log.debug(`[Matter] pre-rename unregister for ${uuid} returned: ${deps.fmtErr(err)}`);
        }
        deps.registrations.delete(uuid);
        await deps.registerRenamed(device);
    }

    warnOnRegisteredDuplicates(deps);
}

/**
 * Voice-namespace guard on what the controllers *actually* hold.
 *
 * `findDuplicateDisplayNames` checks the computed map, which is duplicate-free
 * by construction and therefore can never catch a stale endpoint still
 * registered under a name the map has since reassigned. This checks
 * `registeredDisplayName` — the name last pushed to matter.js — so a real
 * Alexa-visible ambiguity is surfaced instead of hiding behind a clean table.
 */
function warnOnRegisteredDuplicates(deps: NameFinalizeDeps): void {
    const byName = new Map<string, string[]>();
    for (const [uuid, reg] of deps.registrations) {
        // `registeredDisplayName` is set the moment the accessory is pushed to
        // matter.js, so a still-probing `pending` endpoint is just as visible
        // to a controller as a settled one — and a deferred rename is exactly
        // how a duplicate survives this pass.
        if (!reg.registeredDisplayName || reg.status === 'failed' || reg.status === 'skipped') continue;
        const key = reg.registeredDisplayName.toLowerCase();
        const group = byName.get(key);
        if (group) group.push(uuid);
        else byName.set(key, [uuid]);
    }
    for (const [, uuids] of byName) {
        if (uuids.length < 2) continue;
        const name = deps.registrations.get(uuids[0])?.registeredDisplayName;
        deps.log.warn(
            `[Matter] DUPLICATE registered name "${name}" on ${uuids.join(', ')} — `
            + 'voice commands for it are ambiguous. This is a naming bug, please report it.',
        );
    }
}
