'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TEST_TOKEN,
  startTestServer,
  WsClient,
  authenticatedClient,
  binaryChunk,
} = require('../test-support/helpers');

test('HTTP routes require a token for QR and serve security headers', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const indexResponse = await fetch(`${server.baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  const html = await indexResponse.text();
  assert.match(html, /<script src="\/app\.js" defer><\/script>/);
  assert.match(html, /id="themeBtn"/);
  assert.match(indexResponse.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(indexResponse.headers.get('x-content-type-options'), 'nosniff');

  const appResponse = await fetch(`${server.baseUrl}/app.js`);
  assert.equal(appResponse.status, 200);
  const appScript = await appResponse.text();
  assert.match(appScript, /socket\.binaryType = 'arraybuffer'/);
  assert.match(appScript, /ls_theme/);
  assert.doesNotMatch(appScript, /\.innerHTML\s*=/);

  const healthResponse = await fetch(`${server.baseUrl}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    status: 'ok',
    authRequired: true,
    clients: 0,
  });

  const unauthorized = await fetch(`${server.baseUrl}/qr`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${server.baseUrl}/qr`, {
    headers: { 'x-access-token': TEST_TOKEN },
  });
  assert.equal(authorized.status, 200);
  const qr = await authorized.json();
  assert.match(qr.url, /^http:\/\/.+\/\?token=/);
  assert.match(qr.qr, /^data:image\/png;base64,/);
});

test('WebSocket authentication rejects missing and invalid tokens', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const invalid = await WsClient.connect(server.wsUrl);
  invalid.sendJson({ type: 'auth', token: 'wrong-token-000000000' });
  const invalidError = await invalid.waitForType('auth-error');
  assert.equal(invalidError.data.code, 'AUTH_FAILED');
  const invalidClose = await invalid.closed;
  assert.equal(invalidClose.code, 4401);

  const missing = await WsClient.connect(server.wsUrl);
  missing.sendJson({ type: 'hello', name: 'Budi' });
  await missing.waitForType('auth-error');
  const missingClose = await missing.closed;
  assert.equal(missingClose.code, 4401);

  const badOrigin = await WsClient.connect(server.wsUrl, {
    origin: 'https://evil.example',
  });
  const originClose = await badOrigin.closed;
  assert.equal(originClose.code, 4403);
});

test('authenticated clients receive welcome and user lists', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const alice = await authenticatedClient(server.wsUrl, { name: 'Alice' });
  t.after(() => alice.client.close());

  const users = await alice.client.waitForType('users');
  assert.deepEqual(users.data.users, [{ id: alice.id, name: 'Alice' }]);

  const bob = await authenticatedClient(server.wsUrl, { name: 'Bob' });
  t.after(() => bob.client.close());

  const updatedUsers = await alice.client.waitFor(
    (event) =>
      !event.binary && event.data && event.data.type === 'users' && event.data.users.length === 2
  );
  assert.deepEqual(updatedUsers.data.users, [
    { id: alice.id, name: 'Alice' },
    { id: bob.id, name: 'Bob' },
  ]);
});

test('chat is delivered only to the selected target and broadcast excludes the sender', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const alice = await authenticatedClient(server.wsUrl, { name: 'Alice' });
  const bob = await authenticatedClient(server.wsUrl, { name: 'Bob' });
  t.after(() => alice.client.close());
  t.after(() => bob.client.close());

  alice.client.sendJson({ type: 'chat', text: 'private', target: bob.id });
  const privateChat = await bob.client.waitForType('chat');
  assert.equal(privateChat.data.text, 'private');
  assert.equal(privateChat.data.fromId, alice.id);
  assert.equal(privateChat.data.from, 'Alice');
  await alice.client.expectNoMessage(
    (event) => !event.binary && event.data && event.data.type === 'chat'
  );

  alice.client.sendJson({ type: 'chat', text: 'everyone' });
  const broadcastChat = await bob.client.waitForType('chat');
  assert.equal(broadcastChat.data.text, 'everyone');
  await alice.client.expectNoMessage(
    (event) => !event.binary && event.data && event.data.type === 'chat'
  );

  alice.client.sendJson({ type: 'chat', text: 'nowhere', target: 'missing-peer' });
  const error = await alice.client.waitForType('error');
  assert.equal(error.data.code, 'TARGET_NOT_FOUND');
});

test('file chunks are relayed only to the selected recipient', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const alice = await authenticatedClient(server.wsUrl, { name: 'Alice' });
  const bob = await authenticatedClient(server.wsUrl, { name: 'Bob' });
  t.after(() => alice.client.close());
  t.after(() => bob.client.close());

  const fileId = 'file-integration';
  const payload = Buffer.from('hello');

  alice.client.sendJson({
    type: 'file-start',
    fileId,
    name: 'hello.txt',
    mime: 'text/plain',
    size: payload.length,
    target: bob.id,
  });

  const ack = await alice.client.waitForType('file-start-ack');
  assert.equal(ack.data.recipients, 1);

  const fileStart = await bob.client.waitForType('file-start');
  assert.equal(fileStart.data.fileId, fileId);
  assert.equal(fileStart.data.from, 'Alice');
  assert.equal(fileStart.data.size, payload.length);

  const forbiddenChunk = binaryChunk(fileId, 'evil');
  bob.client.sendBinary(forbiddenChunk);
  const forbidden = await bob.client.waitForType('error');
  assert.equal(forbidden.data.code, 'TRANSFER_FORBIDDEN');

  alice.client.sendBinary(binaryChunk(fileId, payload));
  const chunk = await bob.client.waitFor((event) => event.binary);
  assert.deepEqual(chunk.data, binaryChunk(fileId, payload));
  await alice.client.expectNoMessage((event) => event.binary);

  alice.client.sendJson({ type: 'file-end', fileId });
  const fileEnd = await bob.client.waitForType('file-end');
  assert.equal(fileEnd.data.fileId, fileId);
  assert.equal(fileEnd.data.size, payload.length);

  const endAck = await alice.client.waitForType('file-end-ack');
  assert.equal(endAck.data.fileId, fileId);
});

test('invalid messages produce structured errors', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const alice = await authenticatedClient(server.wsUrl, { name: 'Alice' });
  t.after(() => alice.client.close());

  alice.client.sendRaw('{not-json');
  const invalidJson = await alice.client.waitForType('error');
  assert.equal(invalidJson.data.code, 'INVALID_JSON');

  alice.client.sendJson({ type: 'chat', text: 42 });
  const invalidText = await alice.client.waitForType('error');
  assert.equal(invalidText.data.code, 'INVALID_TEXT');

  alice.client.sendJson({ type: 'wat' });
  const unknown = await alice.client.waitForType('error');
  assert.equal(unknown.data.code, 'UNKNOWN_TYPE');

  alice.client.sendJson({ type: 'chat', text: 'x', unexpected: true });
  const unknownField = await alice.client.waitForType('error');
  assert.equal(unknownField.data.code, 'UNKNOWN_FIELD');
});

test('chat rate limiting returns RATE_LIMITED', async (t) => {
  const server = await startTestServer({
    CHAT_RATE_CAPACITY: '2',
    CHAT_RATE_REFILL_PER_SEC: '1',
  });
  t.after(() => server.close());

  const alice = await authenticatedClient(server.wsUrl, { name: 'Alice' });
  const bob = await authenticatedClient(server.wsUrl, { name: 'Bob' });
  t.after(() => alice.client.close());
  t.after(() => bob.client.close());

  alice.client.sendJson({ type: 'chat', text: 'one' });
  await bob.client.waitForType('chat');
  alice.client.sendJson({ type: 'chat', text: 'two' });
  await bob.client.waitForType('chat');
  alice.client.sendJson({ type: 'chat', text: 'three' });

  const error = await alice.client.waitForType('error');
  assert.equal(error.data.code, 'RATE_LIMITED');
});

test('closing the sender cancels in-flight transfers for recipients', async (t) => {
  const server = await startTestServer();
  t.after(() => server.close());

  const alice = await authenticatedClient(server.wsUrl, { name: 'Alice' });
  const bob = await authenticatedClient(server.wsUrl, { name: 'Bob' });
  t.after(() => bob.client.close());

  const fileId = 'file-cancel-1';
  alice.client.sendJson({
    type: 'file-start',
    fileId,
    name: 'cancel.txt',
    mime: 'text/plain',
    size: 5,
    target: bob.id,
  });
  await alice.client.waitForType('file-start-ack');
  await bob.client.waitForType('file-start');

  await alice.client.close();
  const cancelled = await bob.client.waitForType('file-cancel');
  assert.equal(cancelled.data.fileId, fileId);
  assert.equal(cancelled.data.reason, 'sender-disconnected');
});

test('AUTH_DISABLED allows clients without a token', async (t) => {
  const server = await startTestServer({ AUTH_DISABLED: 'true', ACCESS_TOKEN: '' });
  t.after(() => server.close());

  const client = await WsClient.connect(server.wsUrl);
  t.after(() => client.close());
  client.sendJson({ type: 'auth', token: '' });
  const authOk = await client.waitForType('auth-ok');
  assert.equal(authOk.data.authRequired, false);

  client.sendJson({ type: 'hello', clientId: 'guest-cid', name: 'Guest' });
  const welcome = await client.waitForType('welcome');
  assert.equal(welcome.data.name, 'Guest');

  const qr = await fetch(`${server.baseUrl}/qr`);
  assert.equal(qr.status, 200);
});
