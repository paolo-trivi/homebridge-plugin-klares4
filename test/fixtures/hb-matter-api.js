'use strict';

// In-memory model of the bridged Matter API of the Homebridge version installed
// for the tests (2.5.0, matter.js 0.18.0), faithful on the points the plugin's
// topology code depends on. Checked against node_modules/homebridge/dist/matter;
// `test/matter-real-stack-contract.test.js` keeps the device types honest
// against the real stack, and `test/fixtures/real-matter-stack.js` is the real
// thing when a test needs matter.js itself (conformance, behaviors).
//
// registerPlatformAccessories (MatterAPIImpl.js:225-305)
// - Rejects while the bridge server is still starting (:260-263,
//   BaseMatterManager.js:55-63), see `setServerStarting`.
// - Drops, with a logged error, every accessory without UUID, displayName,
//   deviceType, manufacturer, model or serialNumber (:89-131); nothing is
//   emitted for it and the call still resolves (:233-236).
// - Awaits the bridge's work through emitAndWait (:39-43, :275-277): the call
//   resolves once the endpoints exist. A registration error is only logged by
//   the listener (ChildBridgeMatterManager.js:56-60) and the call resolves.
//   MatterServer.registerPlatformAccessories registers the batch in order and
//   the first failure ends the batch (server.js:108-123).
// - A UUID already live in this session is rejected ("already registered",
//   AccessoryManager.js:164-169), unless the endpoint was restored from the
//   cache: then the same shape attaches in place and a different shape is
//   unregistered and registered again (AccessoryManager.js:89-163). The shape
//   is the device type name, the parts, the accessory features, the device
//   type's behaviors and its declared cluster features (:97-128). Attaching in
//   place keeps the restored endpoint and its state: the nodeLabel stays the
//   cached displayName and the cached attribute values stay (:129-157), only
//   the record and the handlers are the plugin's.
// unregisterPlatformAccessories (MatterAPIImpl.js:326-363)
// - Reads accessory.deviceType.deviceType for every accessory before emitting
//   (requiresExternalBridge, :48-50, :335-342): a bare { UUID } stub throws and
//   removes nothing.
// - Awaits the removal (:350-352, AccessoryManager.js:293-341): the call
//   resolves once endpoint.close() has finished (`unregisterCloseMs`); until
//   then the endpoint answers no reads. An unknown UUID resolves silently.
// updateAccessoryState (MatterAPIImpl.js:368-390)
// - Never rejects for an unknown UUID or cluster: the listener logs the
//   failure (ChildBridgeMatterManager.js:76-87, BaseMatterManager.js:152-170)
//   and the StateManager applies the update on a later tick
//   (StateManager.js:72-135, setImmediate). Failed updates land in
//   `rejectedUpdates` and in `log`; applied ones in `updates`.
// - Missing uuid/cluster or empty attributes: logged, nothing emitted.
// getAccessoryState (MatterAPIImpl.js:396-427, StateManager.js:200-246)
// - Returns the cluster attributes, or undefined when the endpoint or the
//   cluster is missing or the endpoint is closing.
// - Every bridged endpoint carries bridgedDeviceBasicInformation, whatever
//   clusters the plugin declared (AccessoryManager.js:181-188).
// updatePlatformAccessories (MatterAPIImpl.js:310-321, server.js:132-160)
// - Emitted without waiting; updates the record (displayName...) of a live
//   endpoint but not the endpoint's nodeLabel.
// deviceTypes (types.js:238-420)
// - Only device types that exist in Homebridge 2.5.0, with their real `name`
//   and code: OnOffOutlet is named 'OnOffPlugInUnit', MotionSensor
//   'OccupancySensor', OnOffSwitch 'OnOffLightSwitch'; there is no
//   `deviceTypes.OnOffPlugInUnit`.
// Commands (`invoke`) reach plugin handlers through
// BehaviorRegistry.executeHandler, which throws "No handler registered" when
// the plugin supplied none. A handler error is rethrown to the controller.

const REAL_DEVICE_TYPES = {
    // key: [name, code, clusters the device type is built from]
    OnOffLight: ['OnOffLight', 256, ['onOff', 'levelControl']],
    DimmableLight: ['DimmableLight', 257, ['onOff', 'levelControl']],
    WindowCovering: ['WindowCovering', 514, ['windowCovering']],
    Thermostat: ['Thermostat', 769, ['thermostat']],
    TemperatureSensor: ['TemperatureSensor', 770, ['temperatureMeasurement']],
    HumiditySensor: ['HumiditySensor', 775, ['relativeHumidityMeasurement']],
    LightSensor: ['LightSensor', 262, ['illuminanceMeasurement']],
    MotionSensor: ['OccupancySensor', 263, ['occupancySensing']],
    ContactSensor: ['ContactSensor', 21, ['booleanState']],
    OnOffSwitch: ['OnOffLightSwitch', 259, ['onOff']],
    OnOffOutlet: ['OnOffPlugInUnit', 266, ['onOff', 'levelControl']],
};

const deviceTypes = {};
for (const [key, [name, code, clusters]] of Object.entries(REAL_DEVICE_TYPES)) {
    deviceTypes[key] = {
        name,
        deviceType: code,
        behaviors: Object.fromEntries(clusters.map((c) => [c, {}])),
    };
}

const BRIDGED_INFO = 'bridgedDeviceBasicInformation';

// homebridge/dist/matter/errors.js: MatterProtocolError(message, code) extends StatusResponseError.
class MatterProtocolError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
const status = {
    MatterProtocolError,
    Failure: class extends MatterProtocolError { constructor(m = 'Operation failed') { super(m, 1); } },
    InvalidInState: class extends MatterProtocolError { constructor(m = 'Operation not allowed in current state') { super(m, 203); } },
    isMatterProtocolError: (error) => error instanceof MatterProtocolError,
};

const REQUIRED_FIELDS = ['UUID', 'displayName', 'deviceType', 'manufacturer', 'model', 'serialNumber'];

// AccessoryManager.js:97-128
function featureShape(features) {
    return JSON.stringify(Object.entries(features ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([clusterName, f]) => ({
            clusterName,
            enabledFeatures: Object.entries(f ?? {}).filter(([, on]) => on === true).map(([n]) => n).sort(),
        }))
        .filter(({ enabledFeatures }) => enabledFeatures.length > 0));
}
function shapeOf(a) {
    return JSON.stringify([
        a.deviceType?.name,
        JSON.stringify((a.parts ?? []).map((p) => ({ id: p.id, features: featureShape(p.features) }))
            .sort((x, y) => x.id.localeCompare(y.id))),
        featureShape(a.features),
        Object.keys(a.deviceType?.behaviors ?? {}).sort().join(','),
        JSON.stringify(Object.entries(a.deviceType?.clusterFeatures ?? {}).sort(([x], [y]) => x.localeCompare(y))),
    ]);
}

const copyClusters = (clusters) => Object.fromEntries(
    Object.entries(clusters ?? {}).map(([name, attrs]) => [name, { ...attrs }]),
);

// `restored`: endpoints restored from Homebridge's Matter cache before the
// plugin registers anything ({ UUID, displayName?, deviceType, clusters?,
// parts?, features? }).
// `unqueryableOnce`: UUIDs whose first endpoint is created but answers no
// cluster read, i.e. present in Homebridge's map yet not queryable;
// `unqueryableTimes` ({ uuid: n }) does the same for the first n endpoints.
// `failRegistration(accessory)`: Homebridge/matter.js refuses the endpoint
// (e.g. a conformance error): the error is only logged and no endpoint exists.
// `serverStarting`: the bridge server has not finished starting.
// `matterReady: false`: no Matter manager is attached yet, so register,
// unregister, updatePlatformAccessories and updateAccessoryState reject
// (assertMatterReady, MatterAPIImpl.js:216-224, :230, :315, :331, :384).
// `unregisterCloseMs`: how long endpoint.close() takes.
function makeHbMatterApi({
    restored = [], unqueryableOnce = [], unqueryableTimes = {}, failRegistration = () => false,
    unregisterCloseMs = 0, serverStarting = false, matterReady = true,
} = {}) {
    let ready = matterReady;
    const assertMatterReady = (action) => {
        if (!ready) throw new Error(`${action} before Homebridge has finished launching.`);
    };
    const unqueryable = new Map(Object.entries(unqueryableTimes));
    for (const uuid of unqueryableOnce) unqueryable.set(uuid, (unqueryable.get(uuid) ?? 0) + 1);
    let starting = serverStarting;
    // uuid -> { deviceType, clusters (live attribute state), shape, restoredFromCache,
    //           nodeLabel, displayName, handlers, reachable, closing? }
    const endpoints = new Map();
    for (const r of restored) {
        endpoints.set(r.UUID, {
            deviceType: r.deviceType,
            clusters: copyClusters(r.clusters),
            shape: shapeOf(r),
            restoredFromCache: true,
            nodeLabel: r.displayName,
            displayName: r.displayName,
            handlers: {},
            reachable: true,
        });
    }
    const log = [];
    const registerCalls = [];
    const unregisterCalls = [];
    const metadataUpdates = [];
    const updates = [];
    const rejectedUpdates = [];

    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const hasCluster = (ep, cluster) => cluster === BRIDGED_INFO || cluster in ep.clusters;

    function createEndpoint(a) {
        const left = unqueryable.get(a.UUID) ?? 0;
        const broken = left > 0;
        if (broken) unqueryable.set(a.UUID, left - 1);
        endpoints.set(a.UUID, {
            deviceType: a.deviceType,
            clusters: broken ? {} : copyClusters(a.clusters),
            shape: shapeOf(a),
            restoredFromCache: false,
            nodeLabel: a.displayName,
            displayName: a.displayName,
            handlers: a.handlers ?? {},
            reachable: true,
        });
    }

    async function closeEndpoint(uuid) {
        const ep = endpoints.get(uuid);
        if (!ep) return;
        ep.closing = true;
        if (unregisterCloseMs > 0) await new Promise((resolve) => setTimeout(resolve, unregisterCloseMs));
        else await tick();
        if (endpoints.get(uuid) === ep) endpoints.delete(uuid);
    }

    // AccessoryManager.registerAccessory; throws like it does.
    async function registerOne(a) {
        await tick();
        const existing = endpoints.get(a.UUID);
        if (existing && !existing.restoredFromCache) {
            throw new Error(`Matter accessory with UUID "${a.UUID}" is already registered.`);
        }
        if (existing && existing.shape === shapeOf(a)) {
            existing.restoredFromCache = false;
            existing.displayName = a.displayName;
            existing.handlers = a.handlers ?? {};
            return;
        }
        if (existing) await closeEndpoint(a.UUID);
        if (failRegistration(a)) throw new Error(`Failed to register accessory: ${a.displayName} refused by matter.js`);
        createEndpoint(a);
    }

    const matter = {
        deviceTypes,
        status,
        registerPlatformAccessories: async (plugin, _platform, accessories) => {
            if (accessories.length === 0) return;
            // Every call the plugin makes, whatever Homebridge does with it.
            for (const a of accessories) {
                registerCalls.push({
                    UUID: a.UUID, displayName: a.displayName, deviceType: a.deviceType?.name, manufacturer: a.manufacturer,
                    model: a.model, serialNumber: a.serialNumber, firmwareRevision: a.firmwareRevision,
                });
            }
            assertMatterReady(`${plugin}: Cannot register Matter accessories`);
            const valid = accessories.filter((a) => {
                const missing = REQUIRED_FIELDS.find((field) => !a[field]);
                if (missing) log.push(`validation: ${a.UUID ?? '?'} missing ${missing}`);
                return !missing;
            });
            if (valid.length === 0) return;
            if (starting) {
                throw new Error(`${plugin}: Cannot register Matter accessories yet — the Matter server for this bridge is still starting. `
                    + 'Register from your platform\'s \'didFinishLaunching\' event; if you already do, this is transient and the '
                    + 'accessories are restored from cache on the next start.');
            }
            try {
                for (const a of valid) await registerOne(a);
            } catch (error) {
                // ChildBridgeMatterManager logs it; the plugin's call resolves.
                log.push(`register failed: ${error.message.split('\n')[0]}`);
            }
        },
        unregisterPlatformAccessories: async (plugin, _platform, accessories) => {
            if (accessories.length === 0) return;
            assertMatterReady(`${plugin}: Cannot unregister Matter accessories`);
            for (const a of accessories) {
                // requiresExternalBridge(accessory.deviceType)
                void a.deviceType.deviceType;
            }
            for (const a of accessories) {
                unregisterCalls.push(a.UUID);
                await closeEndpoint(a.UUID);
            }
        },
        updatePlatformAccessories: async (accessories) => {
            if (accessories.length === 0) return;
            assertMatterReady('Cannot update Matter accessories');
            for (const a of accessories) {
                metadataUpdates.push({ UUID: a.UUID, displayName: a.displayName });
                const ep = endpoints.get(a.UUID);
                if (ep && !ep.restoredFromCache) ep.displayName = a.displayName;
            }
        },
        getAccessoryState: async (uuid, cluster) => {
            const ep = endpoints.get(uuid);
            if (!ep || ep.closing || !cluster) return undefined;
            if (cluster === BRIDGED_INFO) return { nodeLabel: ep.nodeLabel, reachable: ep.reachable };
            return cluster in ep.clusters ? { ...ep.clusters[cluster] } : undefined;
        },
        updateAccessoryState: async (uuid, cluster, attributes) => {
            if (!uuid || !cluster || !attributes || Object.keys(attributes).length === 0) {
                log.push(`updateAccessoryState: invalid arguments for ${uuid}`);
                return;
            }
            assertMatterReady(`Cannot update Matter accessory ${uuid}`);
            setImmediate(() => {
                const ep = endpoints.get(uuid);
                if (!ep || !hasCluster(ep, cluster)) {
                    rejectedUpdates.push({ uuid, cluster, attributes });
                    log.push(`Failed to update Matter accessory state for ${uuid}`);
                    return;
                }
                if (cluster === BRIDGED_INFO) {
                    if ('reachable' in attributes) ep.reachable = attributes.reachable;
                    if ('nodeLabel' in attributes) ep.nodeLabel = attributes.nodeLabel;
                } else {
                    ep.clusters[cluster] = { ...ep.clusters[cluster], ...attributes };
                }
                updates.push({ uuid, cluster, attributes });
            });
        },
    };

    // BehaviorRegistry.executeHandler, as called by the Homebridge cluster servers.
    const invoke = async (uuid, cluster, command, args) => {
        const handler = endpoints.get(uuid)?.handlers?.[cluster]?.[command];
        if (!handler) throw new Error(`No handler registered for ${uuid}.${cluster}.${command}`);
        await handler(args);
    };

    // HomebridgeOnOffServer.toggle(): the 'toggle' handler first, then
    // super.toggle(), whose this.on()/this.off() dispatch back to the
    // Homebridge overrides and so run the 'on'/'off' handler as well.
    const toggle = async (uuid) => {
        await invoke(uuid, 'onOff', 'toggle');
        await settle();
        const onOff = endpoints.get(uuid)?.clusters?.onOff?.onOff ?? false;
        await invoke(uuid, 'onOff', onOff ? 'off' : 'on');
    };

    /** Lets deferred state updates and registrations land. */
    const settle = async () => { await tick(); await tick(); };

    const setServerStarting = (value) => { starting = value; };
    const setMatterReady = (value) => { ready = value; };

    /**
     * What Homebridge's Matter cache would restore on the next start: pass it
     * as `restored` to a new fixture to model a restart.
     */
    const cacheSnapshot = () => [...endpoints.entries()].filter(([, ep]) => !ep.closing).map(([UUID, ep]) => ({
        UUID, displayName: ep.displayName, deviceType: ep.deviceType, clusters: copyClusters(ep.clusters),
    }));

    return {
        api: { matter }, endpoints, log, registerCalls, unregisterCalls, metadataUpdates, updates, rejectedUpdates,
        settle, invoke, toggle, setServerStarting, setMatterReady, cacheSnapshot,
    };
}

module.exports = { makeHbMatterApi, deviceTypes, status, REAL_DEVICE_TYPES };
