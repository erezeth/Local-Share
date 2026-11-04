'use strict';

const crypto = require('node:crypto');

class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

class TargetError extends RegistryError {
  constructor(targetId) {
    super('TARGET_NOT_FOUND', `Recipient "${targetId}" is not online`);
    this.targetId = targetId;
  }
}

class ClientRegistry {
  constructor({
    logger,
    maxClients = 100,
    maxRememberedNames = 1000,
    idFactory = () => crypto.randomBytes(6).toString('hex'),
  }) {
    this.logger = logger;
    this.maxClients = maxClients;
    this.maxRememberedNames = maxRememberedNames;
    this.idFactory = idFactory;
    this.clientsBySocket = new Map();
    this.clientsById = new Map();
    this.rememberedNames = new Map();
  }

  get size() {
    return this.clientsById.size;
  }

  add(ws, { ip = null } = {}) {
    if (this.clientsById.size >= this.maxClients) {
      throw new RegistryError('SERVER_FULL', 'Server has reached its client limit');
    }

    let id;
    do {
      id = this.idFactory();
    } while (!id || this.clientsById.has(id));

    const client = {
      id,
      ws,
      ip,
      name: null,
      authorized: false,
      connectedAt: Date.now(),
      protocolViolations: 0,
    };

    this.clientsBySocket.set(ws, client);
    this.clientsById.set(id, client);
    return client;
  }

  remove(clientOrSocket) {
    const client =
      clientOrSocket && clientOrSocket.ws
        ? clientOrSocket
        : this.clientsBySocket.get(clientOrSocket);
    if (!client) return null;

    this.clientsBySocket.delete(client.ws);
    this.clientsById.delete(client.id);
    return client;
  }

  get(ws) {
    return this.clientsBySocket.get(ws) || null;
  }

  getById(id) {
    if (typeof id !== 'string') return null;
    return this.clientsById.get(id) || null;
  }

  setName(client, name) {
    client.name = name;
    return client;
  }

  listUsers() {
    return [...this.clientsById.values()]
      .filter((client) => client.name)
      .map((client) => ({ id: client.id, name: client.name }));
  }

  recipientsFor(targetIds, { exceptId = null } = {}) {
    const ids = Array.isArray(targetIds) ? targetIds : targetIds ? [targetIds] : [];
    if (ids.length === 0) {
      return [...this.clientsById.values()].filter(
        (client) => client.id !== exceptId && Boolean(client.name)
      );
    }

    const recipients = [];
    for (const targetId of ids) {
      const target = this.getById(targetId);
      if (!target || !target.name || target.id === exceptId) {
        throw new TargetError(targetId);
      }
      recipients.push(target);
    }
    return recipients;
  }

  rememberName(clientId, name) {
    if (!clientId || !name) return;
    this.rememberedNames.delete(clientId);
    this.rememberedNames.set(clientId, name);
    while (this.rememberedNames.size > this.maxRememberedNames) {
      const oldest = this.rememberedNames.keys().next().value;
      if (oldest === undefined) break;
      this.rememberedNames.delete(oldest);
    }
  }

  nameForClientId(clientId) {
    if (!clientId) return null;
    return this.rememberedNames.get(clientId) || null;
  }

  clear() {
    this.clientsBySocket.clear();
    this.clientsById.clear();
    this.rememberedNames.clear();
  }

  nextGuestName() {
    const used = new Set();
    for (const client of this.clientsById.values()) {
      const match = /^user-(\d+)$/.exec(client.name || '');
      if (match) used.add(Number.parseInt(match[1], 10));
    }
    let index = 1;
    while (used.has(index)) index += 1;
    return `user-${index}`;
  }

  send(client, payload) {
    if (!client || client.ws.readyState !== 1) return false;
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return this.sendRaw(client, raw, { binary: false });
  }

  sendRaw(client, payload, { binary = false } = {}) {
    if (!client || client.ws.readyState !== 1) return false;
    try {
      client.ws.send(payload, { binary }, (error) => {
        if (error) {
          this.logger.warn('Failed to send WebSocket message', {
            clientId: client.id,
            error,
          });
        }
      });
      return true;
    } catch (error) {
      this.logger.warn('Failed to send WebSocket message', { clientId: client.id, error });
      return false;
    }
  }

  broadcast(payload, { exceptId = null, authorizedOnly = false } = {}) {
    const raw = JSON.stringify(payload);
    let sent = 0;
    for (const client of this.clientsById.values()) {
      if (client.id === exceptId) continue;
      if (authorizedOnly && !client.authorized) continue;
      if (this.sendRaw(client, raw, { binary: false })) sent += 1;
    }
    return sent;
  }
}

module.exports = { ClientRegistry, RegistryError, TargetError };
