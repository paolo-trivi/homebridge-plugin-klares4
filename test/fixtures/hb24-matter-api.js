'use strict';

// Minimal model of the Homebridge 2.4.0 bridged Matter API, faithful on the
// points the plugin's topology code depends on (verified against
// homebridge/dist/matter/MatterAPIImpl.js and server/AccessoryManager.js):
//
// - registerPlatformAccessories only emits an event and resolves; the real
//   registration happens later and its errors are only logged.
// - A UUID already registered in this session is rejected ("already
//   registered"), unless it is a cache-restored endpoint: then the same shape
//   attaches in place and a different shape is unregistered and re-registered.
// - unregisterPlatformAccessories reads accessory.deviceType.deviceType before
//   emitting anything, so a bare { UUID } stub throws and removes nothing.
// - getAccessoryState returns undefined when the endpoint or the cluster is
//   missing, and already while an unregister is closing the endpoint: the
//   UUID only leaves the registry once endpoint.close() resolves
//   (`unregisterCloseMs`), so a register in that window is still rejected.

const deviceTypes = {};
for (const name of [
    'OnOffLight', 'DimmableLight', 'WindowCovering', 'Thermostat', 'TemperatureSensor',
    'HumiditySensor', 'LightSensor', 'MotionSensor', 'ContactSensor', 'OnOffSwitch',
    'OnOffOutlet', 'OnOffPlugInUnit',
]) {
    deviceTypes[name] = { name, deviceType: name, _t: name };
}

// `unqueryableOnce`: UUIDs whose first endpoint is created but answers no
// cluster probe, i.e. present in Homebridge's map yet not queryable.
function makeHb24MatterApi({ restored = [], unqueryableOnce = [], unregisterCloseMs = 0 } = {}) {
    const unqueryable = new Set(unqueryableOnce);
    // uuid -> { deviceType, clusters, restoredFromCache }
    const endpoints = new Map();
    for (const r of restored) {
        endpoints.set(r.UUID, {
            deviceType: r.deviceType,
            clusters: r.clusters ?? {},
            restoredFromCache: true,
        });
    }
    const log = [];
    const registerCalls = [];
    const unregisterCalls = [];
    const updates = [];

    const settle = () => new Promise((resolve) => setImmediate(resolve));

    const matter = {
        deviceTypes,
        registerPlatformAccessories: async (_plugin, _platform, accessories) => {
            for (const a of accessories) {
                registerCalls.push({ UUID: a.UUID, deviceType: a.deviceType?.name });
                // Fire-and-forget, like the REGISTER_MATTER_PLATFORM_ACCESSORIES event.
                setImmediate(() => {
                    const existing = endpoints.get(a.UUID);
                    if (existing && !existing.restoredFromCache) {
                        log.push(`already registered: ${a.UUID}`);
                        return;
                    }
                    if (existing && existing.deviceType?.name === a.deviceType?.name) {
                        existing.restoredFromCache = false;
                        existing.clusters = a.clusters ?? {};
                        return;
                    }
                    const broken = unqueryable.delete(a.UUID);
                    endpoints.set(a.UUID, {
                        deviceType: a.deviceType,
                        clusters: broken ? {} : (a.clusters ?? {}),
                        restoredFromCache: false,
                    });
                });
            }
        },
        unregisterPlatformAccessories: async (_plugin, _platform, accessories) => {
            for (const a of accessories) {
                // requiresExternalBridge(accessory.deviceType)
                void a.deviceType.deviceType;
            }
            for (const a of accessories) {
                unregisterCalls.push(a.UUID);
                const ep = endpoints.get(a.UUID);
                if (ep) ep.closing = true;
                setTimeout(() => { if (endpoints.get(a.UUID) === ep) endpoints.delete(a.UUID); }, unregisterCloseMs);
            }
        },
        updatePlatformAccessories: async () => {},
        getAccessoryState: async (uuid, cluster) => {
            const ep = endpoints.get(uuid);
            if (!ep || ep.closing) return undefined;
            if (cluster && !(cluster in ep.clusters)) return undefined;
            return {};
        },
        updateAccessoryState: async (uuid, cluster, attributes) => {
            const ep = endpoints.get(uuid);
            if (!ep || !(cluster in ep.clusters)) {
                throw new Error(`Accessory ${uuid} not found or not registered`);
            }
            updates.push({ uuid, cluster, attributes });
        },
    };

    return { api: { matter }, endpoints, log, registerCalls, unregisterCalls, updates, settle };
}

module.exports = { makeHb24MatterApi, deviceTypes };
