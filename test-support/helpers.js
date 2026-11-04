'use strict';

const { WebSocket } = require('ws');
const { createLocalShareServer } = require('../src/create-server');

const TEST_TOKEN = 'test-token-0123456789abcdef';
const silentLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

async function startTestServer(env = {}) {
  const instance = await createLocalShareServer({
    env: {
      PORT: '0',
      HOST: '127.0.0.1',
      ACCESS_TOKEN: TEST_TOKEN,
      AUTH_TIMEOUT_MS: '1000',
      HEARTBEAT_INTERVAL_MS: '5000',
      TRANSFER_IDLE_TIMEOUT_MS: '10000',
      LOG_LEVEL: 'error',
      ...env,
    },
    logger: silentLogger,
  });

  const address = await instance.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}`;

  return {
    ...instance,
    baseUrl,
    wsUrl,
    async close() {
      await instance.close();
    },
  };
}

class WsClient {
  static async connect(url, options = {}) {
    const client = new WsClient(url, options);
    await client.opened;
    return client;
  }

  constructor(url, { origin } = {}) {
    this.messages = [];
    this.waiters = [];
    this.closedCode = null;
    this.closedReason = '';
    this.ws = new WebSocket(url, {
      headers: origin ? { Origin: origin } : {},
    });

    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => {
        this.closedCode = code;
        this.closedReason = reason.toString();
        const error = new Error(`WebSocket closed (${code}) ${this.closedReason}`);
        for (const waiter of this.waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.waiters = [];
        resolve({ code, reason: this.closedReason });
      });
    });

    this.ws.on('message', (data, isBinary) => {
      let event;
      if (isBinary) {
        event = { binary: true, data: Buffer.from(data) };
      } else {
        try {
          event = { binary: false, data: JSON.parse(data.toString('utf8')) };
        } catch (error) {
          event = { binary: false, data: null, parseError: error, raw: data.toString('utf8') };
        }
      }
      this.deliver(event);
    });
  }

  deliver(event) {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(event));
    if (index !== -1) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    this.messages.push(event);
  }

  waitFor(predicate, timeoutMs = 2000) {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) {
      return Promise.resolve(this.messages.splice(index, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex !== -1) this.waiters.splice(waiterIndex, 1);
        reject(new Error('Timed out waiting for a WebSocket message'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  waitForType(type, timeoutMs = 2000) {
    return this.waitFor(
      (event) => !event.binary && event.data && event.data.type === type,
      timeoutMs
    );
  }

  async expectNoMessage(predicate, durationMs = 150) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const found = this.messages.some(predicate);
    if (found) throw new Error('Received an unexpected WebSocket message');
  }

  sendJson(message) {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(data) {
    this.ws.send(data);
  }

  sendBinary(data) {
    this.ws.send(data);
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return { code: this.closedCode };
    this.ws.close();
    const timeout = new Promise((resolve) => setTimeout(resolve, 1000, null));
    const result = await Promise.race([this.closed, timeout]);
    if (!result) {
      this.ws.terminate();
      await this.closed;
    }
    return result;
  }

  terminate() {
    this.ws.terminate();
  }
}

async function authenticatedClient(wsUrl, { token = TEST_TOKEN, name, clientId } = {}) {
  const client = await WsClient.connect(wsUrl);
  client.sendJson({ type: 'auth', token });
  const authOk = await client.waitForType('auth-ok');
  client.sendJson({ type: 'hello', clientId: clientId || `cid-${name}`, name });
  const welcome = await client.waitForType('welcome');
  return { client, authOk, id: welcome.data.id, name: welcome.data.name };
}

function binaryChunk(fileId, payload) {
  const id = Buffer.from(fileId, 'ascii');
  return Buffer.concat([Buffer.from([id.length]), id, Buffer.from(payload)]);
}

module.exports = {
  TEST_TOKEN,
  silentLogger,
  startTestServer,
  WsClient,
  authenticatedClient,
  binaryChunk,
};
