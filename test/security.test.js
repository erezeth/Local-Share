'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeName,
  sanitizeText,
  sanitizeFileName,
  sanitizeId,
  isValidFileId,
  normalizeMime,
  safeTokenEqual,
  TokenBucket,
  FixedWindowLimiter,
} = require('../src/security');
const { loadConfig } = require('../src/config');
const { buildJoinUrl, originAllowed } = require('../src/utils/network');

test('sanitizeName removes markup, control characters and enforces length', () => {
  assert.equal(sanitizeName('<img src=x onerror=alert(1)>'), 'img src=x onerror=al');
  assert.equal(sanitizeName('  Budi\u0000\nSantoso  '), 'Budi Santoso');
  assert.equal(sanitizeName('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopqrst');
  assert.equal(sanitizeName('  '), '');
});

test('sanitizeText keeps user markup as plain text but strips control bytes', () => {
  assert.equal(sanitizeText('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(sanitizeText('halo\u0000\u0007 dunia\r\nbaris'), 'halo dunia\nbaris');
  assert.equal(sanitizeText('x'.repeat(2500)).length, 2000);
});

test('sanitizeFileName removes path traversal and reserved characters', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\Users\\budi\\photo.jpg'), 'photo.jpg');
  assert.equal(sanitizeFileName('bad<name>|?.txt'), 'badname.txt');
  assert.equal(sanitizeFileName(''), 'file');
});

test('IDs and MIME types are constrained', () => {
  assert.equal(sanitizeId('abc-123_XYZ!@#'), 'abc-123_XYZ');
  assert.equal(isValidFileId('f12345678'), true);
  assert.equal(isValidFileId('x'), false);
  assert.equal(isValidFileId('../../secret'), false);
  assert.equal(normalizeMime('IMAGE/PNG'), 'image/png');
  assert.equal(normalizeMime('<script>'), 'application/octet-stream');
  assert.equal(normalizeMime(''), 'application/octet-stream');
});

test('safeTokenEqual compares tokens without leaking length timing', () => {
  assert.equal(safeTokenEqual('same-token', 'same-token'), true);
  assert.equal(safeTokenEqual('same-token', 'other-token'), false);
  assert.equal(safeTokenEqual('short', 'a-much-longer-token'), false);
  assert.equal(safeTokenEqual(null, 'token'), false);
});

test('TokenBucket enforces burst and refill limits', () => {
  let now = 0;
  const bucket = new TokenBucket({
    capacity: 2,
    refillPerSecond: 1,
    now: () => now,
  });

  assert.equal(bucket.consume(1).allowed, true);
  assert.equal(bucket.consume(1).allowed, true);
  const denied = bucket.consume(1);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);

  now = 1000;
  assert.equal(bucket.consume(1).allowed, true);
});

test('FixedWindowLimiter resets after the window and bounds memory', () => {
  let now = 0;
  const limiter = new FixedWindowLimiter({
    limit: 2,
    windowMs: 1000,
    now: () => now,
    maxKeys: 2,
  });

  assert.equal(limiter.take('ip-a'), true);
  assert.equal(limiter.take('ip-a'), true);
  assert.equal(limiter.take('ip-a'), false);

  now = 1001;
  assert.equal(limiter.take('ip-a'), true);

  limiter.take('ip-b');
  limiter.take('ip-c');
  assert.ok(limiter.entries.size <= 2);
});

test('loadConfig generates a token when ACCESS_TOKEN is missing', () => {
  const config = loadConfig({ PORT: '0' });
  assert.equal(config.authRequired, true);
  assert.equal(config.tokenGenerated, true);
  assert.ok(config.accessToken.length >= 32);
});

test('loadConfig rejects weak tokens and incomplete TLS configuration', () => {
  assert.throws(() => loadConfig({ ACCESS_TOKEN: 'too-short' }), /at least 16/);
  assert.throws(() => loadConfig({ TLS_KEY: '/tmp/key.pem' }), /together/);
  assert.throws(() => loadConfig({ MAX_FILE_SIZE_MB: 'not-a-number' }), /MAX_FILE_SIZE_MB/);
});

test('AUTH_DISABLED explicitly removes authentication', () => {
  const config = loadConfig({ AUTH_DISABLED: 'true' });
  assert.equal(config.authRequired, false);
  assert.equal(config.accessToken, null);
});

test('buildJoinUrl includes the token only when authentication is enabled', () => {
  const base = {
    host: '0.0.0.0',
    publicUrl: null,
    tls: null,
    port: 3000,
    authRequired: true,
    accessToken: 'token-0123456789',
  };

  const url = buildJoinUrl({ config: base, port: 3000, lanIp: '192.168.1.10' });
  assert.equal(url, 'http://192.168.1.10:3000/?token=token-0123456789');

  const noToken = buildJoinUrl({
    config: { ...base, authRequired: false },
    port: 3000,
    lanIp: '192.168.1.10',
  });
  assert.equal(noToken, 'http://192.168.1.10:3000');
});

test('originAllowed accepts same-origin, configured origins and non-browser clients', () => {
  assert.equal(originAllowed(undefined, 'localhost:3000', [], null), true);
  assert.equal(originAllowed('http://localhost:3000', 'localhost:3000', [], null), true);
  assert.equal(originAllowed('https://evil.example', 'localhost:3000', [], null), false);
  assert.equal(
    originAllowed('https://share.example', 'internal:3000', ['https://share.example'], null),
    true
  );
  assert.equal(
    originAllowed('https://share.example', 'internal:3000', [], 'https://share.example/'),
    true
  );
});
