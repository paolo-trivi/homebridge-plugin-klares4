'use strict';

// Helpers that model what the Homebridge settings UI does with
// config.schema.json: which keys the form can show, a small validator for the
// subset of JSON Schema the file uses, and a simulated "config -> form model ->
// config" round trip. The UI rebuilds config.json from its form model, so a key
// the layout does not reach is deleted the next time the user saves.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_FILE = path.join(__dirname, '..', '..', 'config.schema.json');

function loadSchemaFile() {
    return JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every key the layout renders, with `[]` marking array items (`rooms[].devices[].deviceId`). */
function layoutKeys(layout) {
    const keys = new Set();
    const walk = (node) => {
        if (node === undefined || node === null) return;
        if (typeof node === 'string') { keys.add(node); return; }
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (typeof node.key === 'string') keys.add(node.key);
        walk(node.items);
    };
    walk(layout);
    return keys;
}

/** The schema node a dotted layout key points to (`rooms[]` descends into `items`). */
function schemaNodeAt(rootSchema, key) {
    let node = rootSchema;
    for (const part of key.split('.')) {
        const isArrayItem = part.endsWith('[]');
        const name = isArrayItem ? part.slice(0, -2) : part;
        node = node?.properties?.[name];
        if (isArrayItem) node = node?.items;
    }
    return node;
}

/** Every leaf property path of the schema; arrays of objects descend into their item properties. */
function schemaPaths(rootSchema) {
    const paths = [];
    const walk = (node, prefix) => {
        for (const [key, value] of Object.entries(node.properties ?? {})) {
            const full = prefix ? `${prefix}.${key}` : key;
            paths.push({ path: full, node: value, container: value.type === 'object' || value.type === 'array' });
            if (value.type === 'object' && value.properties) walk(value, full);
            if (value.type === 'array' && value.items?.type === 'object') walk(value.items, `${full}[]`);
        }
    };
    walk(rootSchema, '');
    return paths;
}

/**
 * What the form does to a config: keeps what the layout reaches (array item
 * fields included), drops the rest. Primitive array items need their own
 * `key[]` layout entry.
 */
function formModel(config, keys) {
    const reachable = (key) => keys.has(key)
        || [...keys].some((other) => other.startsWith(`${key}.`) || other.startsWith(`${key}[]`));
    const project = (value, key) => {
        if (Array.isArray(value)) {
            return value
                .map((item) => (isObject(item) || Array.isArray(item) ? project(item, `${key}[]`) : keys.has(`${key}[]`) ? item : undefined))
                .filter((item) => item !== undefined);
        }
        if (isObject(value)) {
            const out = {};
            for (const [name, inner] of Object.entries(value)) {
                const full = key ? `${key}.${name}` : name;
                if (reachable(full)) out[name] = project(inner, full);
            }
            return out;
        }
        return value;
    };
    return project(config, '');
}

/** Validates `value` against the subset of JSON Schema the file uses; returns a list of problems. */
function validate(value, node, where) {
    const problems = [];
    const fail = (message) => problems.push(`${where}: ${message}`);
    const typeOk = {
        string: typeof value === 'string',
        integer: Number.isInteger(value),
        number: typeof value === 'number' && Number.isFinite(value),
        boolean: typeof value === 'boolean',
        array: Array.isArray(value),
        object: isObject(value),
    };
    if (node.type !== undefined && !typeOk[node.type]) { fail(`expected ${node.type}`); return problems; }
    if (node.enum && !node.enum.includes(value)) fail(`${JSON.stringify(value)} is not one of ${node.enum.join(', ')}`);
    if (node.oneOf?.every((entry) => 'const' in entry) && !node.oneOf.some((entry) => entry.const === value)) {
        fail(`${JSON.stringify(value)} is not one of ${node.oneOf.map((entry) => entry.const).join(', ')}`);
    }
    if (typeof value === 'number') {
        if (node.minimum !== undefined && value < node.minimum) fail(`${value} < ${node.minimum}`);
        if (node.maximum !== undefined && value > node.maximum) fail(`${value} > ${node.maximum}`);
    }
    if (typeof value === 'string') {
        if (node.minLength !== undefined && value.length < node.minLength) fail('too short');
        if (node.maxLength !== undefined && value.length > node.maxLength) fail('too long');
        if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) fail(`does not match ${node.pattern}`);
    }
    if (Array.isArray(value) && node.items) {
        value.forEach((item, index) => problems.push(...validate(item, node.items, `${where}[${index}]`)));
    }
    if (isObject(value) && node.properties) {
        const required = new Set(Array.isArray(node.required) ? node.required : []);
        for (const [name, property] of Object.entries(node.properties)) {
            if (property.required === true) required.add(name);
        }
        for (const name of required) if (!(name in value)) fail(`${name} is required`);
        for (const [name, inner] of Object.entries(value)) {
            if (node.properties[name]) problems.push(...validate(inner, node.properties[name], `${where}.${name}`));
        }
    }
    return problems;
}

/**
 * A configuration that sets every key of the schema to a value that is not its
 * default, so a key that is lost or altered cannot hide behind its default.
 * Device IDs are synthetic.
 */
function completeConfig() {
    return {
        platform: 'Lares4Complete',
        name: 'Klares4 Test',
        ip: '192.0.2.10',
        port: 8443,
        https: false,
        allowInsecureTls: true,
        sender: 'hb-test',
        pin: '123456',
        showAdvanced: true,
        debug: true,
        logLevel: 2,
        maxSeconds: 45,
        reconnectInterval: 7000,
        heartbeatInterval: 20000,
        commandTimeoutMs: 9000,
        coverStepSize: 10,
        scenarioAutoOffDelay: 700,
        exposePartialArmScenarios: true,
        exposeOutputs: [{ outputId: '12', exposeAs: 'light' }, { outputId: '13', exposeAs: 'light' }],
        exposeScenarios: [{ scenarioId: '4' }, { scenarioId: '6' }],
        devicesSummaryDelay: 3000,
        excludeZones: ['1', '2'],
        excludeOutputs: ['3'],
        excludeSensors: ['4', 'sensor_system_temp_in'],
        excludeScenarios: ['5'],
        matterExposure: {
            zones: false, sensors: false, scenarios: false, lights: false, covers: false, gates: false, thermostats: false,
        },
        matterOverrides: [
            { deviceId: 'zone_18', name: 'Study Contact', exposed: false },
            { deviceId: 'light_12', name: 'Ceiling', exposed: true },
        ],
        matterRecoveryRequests: [{ deviceId: 'thermostat_18', generation: 2 }],
        matterUnregisterTimeoutMs: 4000,
        customNames: [{ deviceId: 'light_18', name: 'Reading Light' }, { deviceId: 'cover_1', name: 'Office Blind' }],
        temperatureDefaults: { target: 22, min: 12, max: 30, step: 1 },
        domusThermostat: {
            enabled: false,
            sensorFreshnessMs: 60000,
            manualPairs: [{ thermostatOutputId: '18', domusSensorId: '1' }],
            manualCommandPairs: [{ thermostatOutputId: '18', commandThermostatId: '3' }],
        },
        ksaImport: {
            enabled: true,
            filePath: '/var/lib/homebridge/backup.ksa',
            applyAtStartup: true,
            applyDomusMappings: false,
            applyRoomMapping: false,
            applyCustomNames: true,
        },
        mqtt: {
            enabled: true,
            commands: false,
            broker: 'mqtt://127.0.0.1:1883',
            port: 1884,
            username: 'mqtt_user',
            password: 'mqtt_password',
            clientId: 'klares4-test',
            topicPrefix: 'home/klares4',
            qos: 2,
            retain: false,
        },
        roomMapping: {
            enabled: true,
            rooms: [{ roomName: 'living_room', devices: [{ deviceId: 'light_9', deviceName: 'Ceiling' }, { deviceId: 'sensor_temp_1' }] }],
        },
        generateDebugFile: true,
        debugCaptureDurationMs: 120000,
    };
}

module.exports = { loadSchemaFile, layoutKeys, schemaNodeAt, schemaPaths, formModel, validate, completeConfig, isObject };
