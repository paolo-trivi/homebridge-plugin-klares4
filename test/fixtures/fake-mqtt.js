'use strict';

// In-memory stand-in for an mqtt.js client, injected through MqttBridge's
// `connect` dependency: no socket is ever opened.

const { EventEmitter } = require('node:events');

class FakeMqttClient extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = { ...options };
    this.connected = false;
    this.published = [];
    this.subscriptions = [];
    this.ended = false;
    this.reconnects = 0;
    /** `options.will` as it was at each CONNECT (mqtt.js reads it again every time). */
    this.connectWills = [this.options.will];
  }

  publish(topic, payload, options, callback) {
    this.published.push({ topic, payload: String(payload), options });
    if (callback) callback(undefined);
    return this;
  }

  subscribe(topics, options, callback) {
    this.subscriptions.push({ topics, options });
    if (callback) callback(null);
    return this;
  }

  end(force, opts, callback) {
    this.ended = true;
    this.endForced = force;
    this.connected = false;
    if (typeof callback === 'function') callback();
    return this;
  }

  reconnect() {
    this.reconnects += 1;
    this.connectWills.push(this.options.will);
    this.emit('reconnect');
    return this;
  }

  /** The broker accepted the connection. */
  simulateConnect() {
    this.connected = true;
    this.emit('connect');
  }

  /** The connection dropped (or an attempt failed): mqtt.js emits `close`. */
  simulateClose(error) {
    this.connected = false;
    if (error) this.emit('error', error);
    this.emit('close');
  }

  /** A refused CONNACK, as mqtt.js reports it (`handlers/connack.js`). */
  simulateConnackRefused(code, message = 'Connection refused: Not authorized') {
    const error = new Error(message);
    error.code = code;
    this.simulateClose(error);
  }

  deliver(topic, payload, packet = {}) {
    this.emit('message', topic, Buffer.from(payload), { cmd: 'publish', topic, retain: false, qos: 0, dup: false, ...packet });
  }
}

function fakeMqtt() {
  const calls = [];
  return {
    calls,
    connect(url, options) {
      const client = new FakeMqttClient(url, options);
      calls.push({ url, options, client });
      return client;
    },
    get client() {
      return calls.length > 0 ? calls[calls.length - 1].client : undefined;
    },
  };
}

function recordingLog() {
  const lines = { info: [], debug: [], warn: [], error: [] };
  const format = (args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  return {
    lines,
    all: () => [...lines.info, ...lines.debug, ...lines.warn, ...lines.error].join('\n'),
    logger: {
      info: (...args) => lines.info.push(format(args)),
      debug: (...args) => lines.debug.push(format(args)),
      warn: (...args) => lines.warn.push(format(args)),
      error: (...args) => lines.error.push(format(args)),
      success: (...args) => lines.info.push(format(args)),
    },
  };
}

module.exports = { FakeMqttClient, fakeMqtt, recordingLog };
