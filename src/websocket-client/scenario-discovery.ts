import type { Logger } from 'homebridge';
import type { KseniaDevice, KseniaScenarioData } from '../types';
import { isIgnoredScenarioCategory, normalizeScenarioCategory, parseScenarioData } from './device-parsers';
import { adoptDiscoveredDevice } from './discovered-device';
import { forEachIsolated } from '../isolation';
import type { WebSocketClientState } from './types';

interface DiscoverScenariosInput {
    state: WebSocketClientState;
    log: Logger;
    exposePartialArmScenarios?: boolean;
    onDeviceDiscovered: (device: KseniaDevice) => void;
}

/**
 * Records every scenario's category (triggerScenario checks it again) and
 * discovers only the ones that do not arm or disarm the alarm.
 */
export function discoverScenarios(
    scenarios: KseniaScenarioData[],
    { state, log, exposePartialArmScenarios, onDeviceDiscovered }: DiscoverScenariosInput,
): void {
    log.info(`Found ${scenarios.length} scenarios`);
    forEachIsolated(log, 'READ_RES/MULTI_TYPES SCENARIOS scenario', scenarios, (scenario: KseniaScenarioData): void => {
        const category = normalizeScenarioCategory(scenario.CAT);
        state.scenarioCategoryById.set(String(scenario.ID), category);
        if (isIgnoredScenarioCategory(category, exposePartialArmScenarios)) {
            if (category === 'PARTIAL') {
                log.info(
                    `Scenario ${scenario.DES} not exposed: it partially arms the alarm `
                    + '(set exposePartialArmScenarios to expose it)',
                );
            } else {
                log.debug(`Scenario ${scenario.DES} ignored (category ${scenario.CAT})`);
            }
            return;
        }

        const parsed = parseScenarioData(scenario);
        if (parsed) {
            onDeviceDiscovered(adoptDiscoveredDevice(state.devices, parsed));
        }
    });
}
