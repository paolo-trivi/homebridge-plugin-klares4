'use strict';

// The real Homebridge Matter stack installed in node_modules (HomebridgeAPI,
// MatterAPIImpl, ChildBridgeMatterManager, MatterServer, matter.js), driven the
// way a child bridge drives it, with the node built in deferOnline mode and
// never brought online. Use it to prove that what the plugin hands to
// `api.matter` is accepted by the Homebridge version the tests run against.
//
// What is real and what is not:
// - `api` is a real HomebridgeAPI with the real MatterAPIImpl behind `api.matter`
//   (validation, emitAndWait, assertMatterReady).
// - The listeners are the real ChildBridgeMatterManager's own
//   (`setupEventListeners()`, ChildBridgeMatterManager.js:277-292): register and
//   unregister are awaited, errors are only logged, state updates resolve even
//   when Homebridge fails them.
// - The MatterServer is built with the options ChildBridgeMatterManager.js:190-215
//   uses, `deferOnline: true`. `runServerWhenSettled()` is NOT called: the node
//   stays pre-online for the whole test, which is the window in which a real
//   child bridge receives the plugin's initial registrations.
//
// Network isolation. matter.js creates its MdnsService while the ServerNode is
// built, not when it goes online: ServerNode.create -> NodeServices.install
// (@matter/node/dist/esm/node/server/ServerEnvironment.js:98) loads MdnsService,
// whose construction (@matter/protocol/dist/esm/mdns/MdnsService.js:36-52) binds
// UDP 5353 and joins the mDNS multicast groups through the `Network` service of
// the environment (@matter/general/dist/esm/net/udp/UdpMulticastServer.js:79-103).
// Homebridge only clears `mdns.networkInterface` / `mdns.ipv4`
// (ServerLifecycle.js:291-335), it never replaces the Network. Binding to `lo`
// is not an option either: the IPv6 membership is mandatory
// (UdpMulticastServer.js:93-103) and `lo` has no multicast. So the harness puts
// matter.js's own in-memory network simulator (`NetworkSimulator`/`MockNetwork`,
// @matter/general/dist/esm/net/mock/) in `Environment.default` before the
// ServerNode exists: every UDP socket matter.js opens lives in that simulator,
// and no socket is created on the host. `assertNoHostSockets()` checks it.
//
// The packages are ESM with a CJS twin: they are loaded with import() so the
// harness talks to the same module instances Homebridge uses.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { pathToFileURL } = require('node:url');

const HB_DIST = path.dirname(require.resolve('homebridge'));
const hbModule = (rel) => import(pathToFileURL(path.join(HB_DIST, rel)).href);

let modulesPromise;
function loadModules() {
    modulesPromise ??= (async () => {
        const [api, user, server, manager, general, main] = await Promise.all([
            hbModule('api.js'),
            hbModule('user.js'),
            hbModule('matter/server.js'),
            hbModule('matter/ChildBridgeMatterManager.js'),
            import('@matter/general'),
            import('@matter/main'),
        ]);
        return {
            HomebridgeAPI: api.HomebridgeAPI,
            User: user.User,
            MatterServer: server.MatterServer,
            ChildBridgeMatterManager: manager.ChildBridgeMatterManager,
            Network: general.Network,
            NetworkSimulator: general.NetworkSimulator,
            Environment: main.Environment,
        };
    })();
    return modulesPromise;
}

// Counts host UDP sockets bound while a stack is alive (mDNS would be one). The
// prototype is shared by the CJS and ESM faces of node:dgram, so this sees the
// sockets matter.js would open through its NodeJsNetwork.
const hostSockets = { count: 0 };
const originalBind = dgram.Socket.prototype.bind;
let socketSpyUsers = 0;
function spyOnHostSockets() {
    if (socketSpyUsers++ === 0) {
        dgram.Socket.prototype.bind = function bindSpy(...args) {
            hostSockets.count++;
            return originalBind.apply(this, args);
        };
    }
}
function releaseHostSocketSpy() {
    if (--socketSpyUsers === 0) dgram.Socket.prototype.bind = originalBind;
}

// Homebridge and matter.js log through console.*; keep their lines for the test.
function captureConsole(lines) {
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const sink = (...args) => {
        lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : String(a)))
            .join(' ').replace(/\x1b\[[0-9;]*m/g, ''));
    };
    for (const key of Object.keys(saved)) console[key] = sink;
    return () => Object.assign(console, saved);
}

const BRIDGE_USERNAME = '0E:AA:BB:CC:DD:01';

/**
 * Starts the stack on `storagePath` (a test-owned directory; the Matter cache
 * lives under `<storagePath>/matter`). A second call on the same directory is a
 * Homebridge restart: the cached endpoints are restored before any registration.
 */
async function startRealMatterStack({ storagePath, plugin = 'homebridge-plugin-klares4' } = {}) {
    if (!storagePath) throw new Error('startRealMatterStack needs a storagePath');
    const m = await loadModules();
    const hbLines = [];
    const restoreConsole = captureConsole(hbLines);
    spyOnHostSockets();
    try {
        m.Environment.default.set(m.Network, new m.NetworkSimulator().addHost(1));
        m.User.storageAccessed = false;
        m.User.setStoragePath(storagePath);

        const api = new m.HomebridgeAPI();
        await api.loadMatterAPI();
        const manager = new m.ChildBridgeMatterManager(
            { username: BRIDGE_USERNAME, name: 'Test Bridge', matter: { port: 5540 } },
            { debugModeEnabled: false },
            api,
            { requestMatterPort: async () => 5540, releaseMatterPort: () => {} },
            { getPlugin: () => undefined, getPluginByActiveDynamicPlatform: () => undefined },
        );
        const serialNumber = BRIDGE_USERNAME.replace(/:/g, '');
        const server = new m.MatterServer({
            port: 5540,
            uniqueId: serialNumber,
            storagePath: m.User.matterPath(),
            displayName: 'Test Bridge',
            debugModeEnabled: false,
            manufacturer: 'homebridge.io',
            model: 'homebridge',
            serialNumber,
            networkInterfaces: [],
            deferOnline: true,
        });
        await server.start();
        manager.matterServer = server;
        api._setMatterEnabled(true);
        api._setMatterServer(server);
        api._setMatterManager(manager);
        manager.setupEventListeners();

        const record = (uuid) => server.accessories.get(uuid);
        let stopped = false;
        const stack = {
            api, server, manager, storagePath, hbLines, plugin,
            /** Homebridge's own record of a registered accessory, or undefined. */
            record,
            /** Name of the device type of the live endpoint (e.g. 'OnOffPlugInUnit'). */
            deviceTypeName: (uuid) => record(uuid)?.deviceType?.name,
            /** Attributes of a cluster as a controller would read them. */
            read: (uuid, cluster) => server.getAccessoryState(uuid, cluster),
            /** A controller command, through the Homebridge behaviors into the plugin handlers. */
            invoke: (uuid, cluster, command, args) => server.triggerCommand(uuid, cluster, command, args),
            /** A controller attribute write in its own transaction. */
            write: (uuid, cluster, attributes) => record(uuid).endpoint.set({ [cluster]: attributes }),
            /** Accessories in Homebridge's Matter cache, in the shape a platform receives them. */
            cached: () => server.getAllCachedAccessories().map((c) => manager.deserializeMatterAccessory(c)),
            /** Waits for the debounced state applications (StateManager defers each update). */
            settle: () => new Promise((resolve) => setImmediate(resolve)),
            hostSocketsBound: () => hostSockets.count,
            /**
             * Stops the bridge. The cache is saved first, as a running bridge does
             * on shutdown (ServerLifecycle.stop saves only when the node ran).
             */
            async stop() {
                if (stopped) return;
                stopped = true;
                try {
                    if (server.accessoryCache && server.accessories.size > 0) {
                        await server.accessoryCache.save(server.accessories);
                    }
                    await manager.teardown();
                } finally {
                    releaseHostSocketSpy();
                    restoreConsole();
                }
            },
        };
        return stack;
    } catch (error) {
        releaseHostSocketSpy();
        restoreConsole();
        throw error;
    }
}

/**
 * One Homebridge storage directory for test `t`, and the stacks started on it
 * (a second `start()` after `stop()` is a restart with cache). When the test
 * ends, every stack still running is stopped and the directory is removed.
 */
function realMatterStackSession(t) {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'klares4-hb-'));
    const stacks = [];
    t.after(async () => {
        try {
            for (const stack of stacks) await stack.stop();
        } finally {
            fs.rmSync(storagePath, { recursive: true, force: true });
        }
    });
    return {
        storagePath,
        async start() {
            const stack = await startRealMatterStack({ storagePath });
            stacks.push(stack);
            return stack;
        },
    };
}

module.exports = { startRealMatterStack, realMatterStackSession };
