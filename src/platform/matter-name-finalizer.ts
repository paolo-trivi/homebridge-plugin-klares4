import type { Logger } from 'homebridge';
import type { KseniaDevice } from '../types';
import type { MatterRegistration } from './matter-registration-recovery';
import type { MatterNameService } from './matter-name-service';
import { logNameTable, type MatterNameMapEntry } from './matter-name-map';
import { analyzeMatterVoiceCollisions } from './matter-voice-analyzer';
import { registrationProbeCluster, type MatterTopologyCoordinator } from './matter-topology-coordinator';

export interface NameFinalizeDeps {
    topologyCoordinator: MatterTopologyCoordinator;
    log: Logger;
    nameService: MatterNameService;
    registrations: Map<string, MatterRegistration>;
    recordMetadataChanged: () => void;
    /** Fallback when the in-place rename is not observed: register again (same UUID; `[rename]`). */
    registerRenamed: (device: KseniaDevice, inheritUniqueId?: string) => Promise<void>;
    fmtErr: (err: unknown) => string;
}

/**
 * Two-phase naming, phase 2 — runs when the initial WS sync is complete and
 * the full device set is known. Batch-recomputes the authoritative name-map,
 * persists it, logs the final name → uuid table (with a WARN guard on
 * case-insensitive duplicates), and renames only the endpoints whose live
 * nodeLabel differs from the map — rare: devices added/renamed on the panel,
 * a `matterOverrides` name, or the very first boot without a persisted map.
 *
 * The live label is read from the endpoint, not deduced: after an attach in
 * place Homebridge keeps the restored endpoint, and its label, whatever
 * displayName the plugin registered (AccessoryManager.js:124-157).
 */
export async function finalizeMatterNameMap(devices: KseniaDevice[], deps: NameFinalizeDeps): Promise<void> {
    const { entries, duplicates, persisted } = deps.nameService.finalize(devices);
    logNameTable(deps.log, entries.values(), duplicates);
    if (persisted) deps.log.info(`[Matter] name-map updated and persisted (${entries.size} devices)`);
    logVoiceAnalysis(devices, entries, deps.log);

    const devicesById = new Map(devices.map((device) => [device.id, device]));
    for (const [deviceId, reg] of [...deps.registrations]) {
        const target = entries.get(deviceId)?.name;
        if (!target || !reg) continue;
        if (reg.status !== 'registered') {
            if (reg.registeredDisplayName !== target) {
                deps.log.debug(`[Matter] name refresh deferred for ${deviceId} (status=${reg.status}); next register uses "${target}"`);
            }
            continue;
        }
        // One device must never abort the rest of the batch: a rename that fails
        // leaves that endpoint on its previous name, which stays correct and
        // queryable, while every other pending rename still gets its turn.
        try {
            await refreshName(deviceId, reg, target, devicesById.get(deviceId), deps);
        } catch (err) {
            deps.log.warn(`[Matter] name refresh failed for ${deviceId}, keeping previous name: ${deps.fmtErr(err)}`);
        }
    }
}

function logVoiceAnalysis(devices: KseniaDevice[], entries: Map<string, MatterNameMapEntry>, log: Logger): void {
    const voiceAnalysis = analyzeMatterVoiceCollisions(devices, entries);
    const critical = voiceAnalysis.findings.filter((finding) => finding.severity === 'CRITICAL').length;
    const high = voiceAnalysis.findings.filter((finding) => finding.severity === 'HIGH').length;
    log.info(
        `[Matter] voice analysis: exposed=${devices.length} critical=${critical} high=${high} `
        + `hash=${voiceAnalysis.hash}`,
    );
    for (const finding of voiceAnalysis.findings) {
        log.debug(
            `[Matter] voice ${finding.severity} ${finding.leftId}/${finding.rightId}: `
            + `${finding.score} [${finding.lexicalEvidence.join(',')}] [${finding.riskReasons.join(',')}]`,
        );
    }
}

async function refreshName(
    deviceId: string,
    reg: MatterRegistration,
    target: string,
    discovered: KseniaDevice | undefined,
    deps: NameFinalizeDeps,
): Promise<void> {
    const coordinator = deps.topologyCoordinator;
    const live = await coordinator.readNodeLabel(deviceId) ?? reg.registeredDisplayName;
    if (live === target) {
        reg.registeredDisplayName = target;
        // Attached in place under another name: Homebridge's record (and so its
        // cache) holds the registered displayName, not the label the endpoint shows.
        if (reg.matterAccessory.displayName !== target) {
            reg.matterAccessory = { ...reg.matterAccessory, displayName: target };
            await coordinator.updateCachedRecord(reg.matterAccessory);
        }
        return;
    }

    deps.log.info(`[Matter] name refresh requested: "${live ?? '?'}" -> "${target}" (uuid=${deviceId})`);
    deps.recordMetadataChanged();
    if (await coordinator.renameInPlace(reg.matterAccessory, target)) {
        reg.matterAccessory = { ...reg.matterAccessory, displayName: target };
        reg.displayName = target;
        reg.registeredDisplayName = target;
        return;
    }

    // Only when the endpoint did not take the new label: replace it, keeping its identity.
    const device = discovered ?? reg.matterAccessory.context?.device as KseniaDevice | undefined;
    if (!device) {
        deps.log.warn(`[Matter] name refresh skipped for ${deviceId}: device snapshot unavailable`);
        return;
    }
    deps.log.warn(`[Matter] ${deviceId}: the endpoint did not take the new name in place; re-registering it`);
    const uniqueId = await coordinator.readUniqueId(deviceId);
    const removed = await coordinator.unregister(deviceId, registrationProbeCluster(reg.matterAccessory));
    if (!removed) {
        deps.log.warn(`[Matter] name refresh skipped for ${deviceId}: endpoint still present after unregister`);
        return;
    }
    deps.registrations.delete(deviceId);
    coordinator.inheritOnNextRegister(deviceId, uniqueId);
    await deps.registerRenamed(device, uniqueId);
}
