import type { Logger } from 'homebridge';
import type { KseniaDevice, KseniaScenarioData } from '../types';
import { normalizeScenarioCategory, parseScenarioData, resolveScenarioExposure } from './device-parsers';
import { adoptDiscoveredDevice } from './discovered-device';
import type { ReadFindings } from './exposure-report';
import { forEachIsolated } from '../isolation';
import type { HiddenDevice, WebSocketClientState } from './types';

interface DiscoverScenariosInput {
    state: WebSocketClientState;
    log: Logger;
    exposePartialArmScenarios?: boolean;
    /** Panel IDs listed in `exposeScenarios`. */
    optInIds: ReadonlySet<string>;
    onDeviceDiscovered: (device: KseniaDevice) => void;
}

/**
 * Records every scenario's category (triggerScenario checks it again) and
 * discovers only the ones the scenario policy exposes (`resolveScenarioExposure`).
 * Returns what was hidden, opt-in rows without effect and the exposed
 * scenarios the panel flags with a PIN, for the startup report.
 */
export function discoverScenarios(
    scenarios: KseniaScenarioData[],
    { state, log, exposePartialArmScenarios, optInIds, onDeviceDiscovered }: DiscoverScenariosInput,
): ReadFindings {
    log.info(`Found ${scenarios.length} scenarios`);
    const findings: ReadFindings = { hidden: [], ignoredOptIns: [], pinFlagged: [] };
    const listed = new Set<string>();
    forEachIsolated(log, 'READ_RES/MULTI_TYPES SCENARIOS scenario', scenarios, (scenario: KseniaScenarioData): void => {
        const panelId = String(scenario.ID);
        listed.add(panelId);
        const category = normalizeScenarioCategory(scenario.CAT);
        state.scenarioCategoryById.set(panelId, category);
        const optedIn = optInIds.has(panelId);
        const exposure = resolveScenarioExposure(category, exposePartialArmScenarios, optedIn);
        const parsed = parseScenarioData(scenario);
        if (!exposure.exposed) {
            findings.hidden.push(hiddenScenario(panelId, parsed.name, category, exposure.reason));
            logHidden(log, parsed.name, category, exposure.reason);
            if (optedIn && exposure.reason !== 'unknown-category') {
                findings.ignoredOptIns.push(
                    `exposeScenarios: scenario ${panelId} "${parsed.name}" (category ${category}) `
                    + (exposure.reason === 'arming'
                        ? 'arms or disarms the alarm and is never exposed'
                        : 'partially arms the alarm: only exposePartialArmScenarios exposes it'),
                );
            }
            return;
        }
        if (optedIn && exposure.source !== 'opt-in') {
            findings.ignoredOptIns.push(
                `exposeScenarios: scenario ${panelId} "${parsed.name}" (category ${category || 'none'}) is exposed without it`,
            );
        }
        if (parsed.pinFlag !== undefined && parsed.pinFlag !== 'N') {
            findings.pinFlagged.push(`scenario ${panelId} "${parsed.name}" (category ${category || 'none'}, PIN flag ${parsed.pinFlag})`);
        }
        onDeviceDiscovered(adoptDiscoveredDevice(state.devices, parsed));
    });
    for (const panelId of optInIds) {
        if (!listed.has(panelId)) {
            findings.ignoredOptIns.push(`exposeScenarios: scenario ${panelId} is not listed by the panel`);
        }
    }
    return findings;
}

function hiddenScenario(
    panelId: string,
    name: string,
    category: string,
    reason: 'arming' | 'partial-arm' | 'unknown-category',
): HiddenDevice {
    return {
        deviceId: `scenario_${panelId}`,
        kind: 'scenario',
        panelId,
        name,
        category,
        optInAllowed: reason === 'unknown-category',
    };
}

function logHidden(log: Logger, name: string, category: string, reason: 'arming' | 'partial-arm' | 'unknown-category'): void {
    if (reason === 'partial-arm') {
        log.info(
            `Scenario ${name} not exposed: it partially arms the alarm `
            + '(set exposePartialArmScenarios to expose it)',
        );
    } else if (reason === 'arming') {
        log.debug(`Scenario ${name} ignored (category ${category})`);
    } else {
        log.debug(`Scenario ${name} not exposed: category ${category || 'none'} is not recognized`);
    }
}
