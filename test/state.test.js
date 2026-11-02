'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ClientRegistry, RegistryError, TargetError } = require('../src/state');

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.bufferedAmount = 0;
    this.closed = false;
  }

  send(data, options, callback) {
    this.sent.push({ data, options });
    if (callback) callback();
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

function createRegistry() {
  let nextId = 1;
  return new ClientRegistry({
    logger: { warn() {} },
    maxClients: 3,
    idFactory: () => `p${nextId++}`,
  });
}

test('registry assigns unique IDs and lists only named users', () => {
  const registry = createRegistry();
  const first = registry.add(new FakeSocket(), { ip: '127.0.0.1' });
  const second = registry.add(new FakeSocket());

  assert.notEqual(first.id, second.id);
  assert.equal(registry.size, 2);
  assert.deepEqual(registry.listUsers(), []);

  registry.setName(first, 'Budi');
  registry.setName(second, 'Sari');
  assert.deepEqual(registry.listUsers(), [
    { id: 'p1', name: 'Budi' },
    { id: 'p2', name: 'Sari' },
  ]);
});

test('targeted delivery reaches only the requested recipient', () => {
  const registry = createRegistry();
  const sender = registry.add(new FakeSocket());
  const target = registry.add(new FakeSocket());
  const other = registry.add(new FakeSocket());
  registry.setName(sender, 'Sender');
  registry.setName(target, 'Target');
  registry.setName(other, 'Other');

  const recipients = registry.recipientsFor('p2', { exceptId: sender.id });
  assert.deepEqual(
    recipients.map((client) => client.id),
    ['p2']
  );

  assert.equal(registry.send(recipients[0], { type: 'chat', text: 'hi' }), true);
  assert.equal(target.ws.sent.length, 1);
  assert.equal(other.ws.sent.length, 0);
  assert.equal(sender.ws.sent.length, 0);
  assert.equal(JSON.parse(target.ws.sent[0].data).text, 'hi');
});

test('broadcast excludes the sender and includes every other named client', () => {
  const registry = createRegistry();
  const sender = registry.add(new FakeSocket());
  const target = registry.add(new FakeSocket());
  registry.setName(sender, 'Sender');
  registry.setName(target, 'Target');

  const sent = registry.broadcast({ type: 'users' }, { exceptId: sender.id });

  assert.equal(sent, 1);
  assert.equal(target.ws.sent.length, 1);
  assert.equal(sender.ws.sent.length, 0);
});

test('target resolution fails for missing and self recipients', () => {
  const registry = createRegistry();
  const sender = registry.add(new FakeSocket());
  registry.setName(sender, 'Sender');

  assert.throws(
    () => registry.recipientsFor('missing', { exceptId: sender.id }),
    (error) => error instanceof TargetError && error.code === 'TARGET_NOT_FOUND'
  );
  assert.throws(
    () => registry.recipientsFor(sender.id, { exceptId: sender.id }),
    (error) => error.code === 'TARGET_NOT_FOUND'
  );
});

test('guest names are unique across currently connected clients', () => {
  const registry = createRegistry();
  const first = registry.add(new FakeSocket());
  registry.setName(first, registry.nextGuestName());
  const second = registry.add(new FakeSocket());
  registry.setName(second, registry.nextGuestName());

  assert.equal(first.name, 'user-1');
  assert.equal(second.name, 'user-2');
});

test('remembered names are bounded and survive reconnects', () => {
  const registry = new ClientRegistry({
    logger: { warn() {} },
    maxRememberedNames: 2,
    idFactory: (() => {
      let id = 0;
      return () => `p${++id}`;
    })(),
  });

  registry.rememberName('cid-a', 'Budi');
  registry.rememberName('cid-b', 'Sari');
  registry.rememberName('cid-c', 'Tono');

  assert.equal(registry.nameForClientId('cid-a'), null);
  assert.equal(registry.nameForClientId('cid-b'), 'Sari');
  assert.equal(registry.nameForClientId('cid-c'), 'Tono');
});

test('registry enforces the maximum client count and removes clients', () => {
  const registry = createRegistry();
  const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
  for (const socket of sockets) registry.add(socket);

  assert.throws(
    () => registry.add(new FakeSocket()),
    (error) => error instanceof RegistryError && error.code === 'SERVER_FULL'
  );

  registry.remove(sockets[0]);
  assert.equal(registry.size, 2);
  assert.equal(registry.get(sockets[0]), null);
});
