import type { Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterNameService } from './matter-name-service';
import { logNameTable } from './matter-name-map';
import { analyzeMatterVoiceCollisions } from './matter-voice-analyzer';
import { registrationProbeCluster, type MatterTopologyCoordinator } from './matter-topology-coordinator';

export interface NameFinalizeDeps {
    topologyCoordinator: MatterTopologyCoordinator;
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
    const voiceAnalysis = analyzeMatterVoiceCollisions(devices, entries);
    const critical = voiceAnalysis.findings.filter((finding) => finding.severity === 'CRITICAL').length;
    const high = voiceAnalysis.findings.filter((finding) => finding.severity === 'HIGH').length;
    deps.log.info(
        `[Matter] voice analysis: exposed=${devices.length} critical=${critical} high=${high} `
        + `hash=${voiceAnalysis.hash}`,
    );
    for (const finding of voiceAnalysis.findings) {
        deps.log.debug(
            `[Matter] voice ${finding.severity} ${finding.leftId}/${finding.rightId}: `
            + `${finding.score} [${finding.lexicalEvidence.join(',')}] [${finding.riskReasons.join(',')}]`,
        );
    }

    const devicesById = new Map(devices.map((device) => [device.id, device]));
    for (const [deviceId, reg] of [...deps.registrations]) {
        const target = entries.get(deviceId)?.name;
        if (!target || !reg || reg.registeredDisplayName === target) continue;
        if (reg.status !== 'registered') {
            deps.log.debug(`[Matter] name refresh deferred for ${deviceId} (status=${reg.status}); next register uses "${target}"`);
            continue;
        }
        const device = devicesById.get(deviceId)
            ?? reg.matterAccessory.context?.device as KseniaDevice | undefined;
        if (!device) {
            deps.log.warn(`[Matter] name refresh skipped for ${deviceId}: device snapshot unavailable`);
            continue;
        }

        deps.log.info(`[Matter] name refresh requested: "${reg.registeredDisplayName}" -> "${target}" (uuid=${deviceId})`);
        deps.recordMetadataChanged();
        const removed = await deps.topologyCoordinator.unregister(
            deviceId,
            registrationProbeCluster(reg.matterAccessory),
        );
        if (!removed) continue;
        deps.registrations.delete(deviceId);
        await deps.registerRenamed(device);
    }
}
