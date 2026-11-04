'use strict';

const crypto = require('node:crypto');

const MIN_TOKEN_LENGTH = 16;

function readString(env, name, fallback = '') {
  const value = env[name];
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function readInt(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function readBool(env, name, fallback = false) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be a boolean (true/false)`);
}

function readList(env, name) {
  return readString(env, name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const authDisabled = readBool(env, 'AUTH_DISABLED', false);
  const configuredToken = readString(env, 'ACCESS_TOKEN');
  const tlsKeyPath = readString(env, 'TLS_KEY');
  const tlsCertPath = readString(env, 'TLS_CERT');

  if (Boolean(tlsKeyPath) !== Boolean(tlsCertPath)) {
    throw new Error('TLS_KEY and TLS_CERT must be provided together');
  }
  if (!authDisabled && configuredToken && configuredToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`ACCESS_TOKEN must contain at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const tokenGenerated = !authDisabled && !configuredToken;
  const accessToken = authDisabled
    ? null
    : configuredToken || crypto.randomBytes(32).toString('base64url');

  const maxFileSizeMb = readInt(env, 'MAX_FILE_SIZE_MB', 100, { min: 0, max: 2048 });
  const fileRateMbps = readInt(env, 'FILE_RATE_MBPS', 32, { min: 1, max: 1024 });
  const fileBurstMb = readInt(env, 'FILE_RATE_BURST_MB', 4, { min: 1, max: 256 });

  return Object.freeze({
    port: readInt(env, 'PORT', 3000, { min: 0, max: 65535 }),
    host: readString(env, 'HOST', '0.0.0.0') || '0.0.0.0',
    publicUrl: readString(env, 'PUBLIC_URL') || null,
    trustProxy: readBool(env, 'TRUST_PROXY', false),
    logLevel: readString(env, 'LOG_LEVEL', 'info') || 'info',

    authRequired: !authDisabled,
    accessToken,
    tokenGenerated,

    tls: tlsKeyPath ? { keyPath: tlsKeyPath, certPath: tlsCertPath } : null,
    allowedOrigins: readList(env, 'ALLOWED_ORIGINS'),

    maxClients: readInt(env, 'MAX_CLIENTS', 100, { min: 1, max: 10000 }),
    maxNameLength: 20,
    maxChatLength: 2000,
    maxFileSize: maxFileSizeMb * 1024 * 1024,
    maxActiveTransfers: readInt(env, 'MAX_ACTIVE_TRANSFERS', 3, { min: 1, max: 50 }),
    // The browser sends 16 KiB chunks plus a small header, so a lower cap breaks file transfer.
    wsMaxPayload: readInt(env, 'WS_MAX_PAYLOAD_BYTES', 64 * 1024, {
      min: 32 * 1024,
      max: 32 * 1024 * 1024,
    }),
    wsMaxBufferedBytes: readInt(env, 'WS_MAX_BUFFERED_BYTES', 16 * 1024 * 1024, {
      min: 256 * 1024,
      max: 512 * 1024 * 1024,
    }),

    authTimeoutMs: readInt(env, 'AUTH_TIMEOUT_MS', 10000, { min: 1000, max: 120000 }),
    heartbeatIntervalMs: readInt(env, 'HEARTBEAT_INTERVAL_MS', 30000, {
      min: 5000,
      max: 300000,
    }),
    transferIdleTimeoutMs: readInt(env, 'TRANSFER_IDLE_TIMEOUT_MS', 60000, {
      min: 10000,
      max: 1800000,
    }),

    chatRateCapacity: readInt(env, 'CHAT_RATE_CAPACITY', 12, { min: 1, max: 1000 }),
    chatRateRefillPerSec: readInt(env, 'CHAT_RATE_REFILL_PER_SEC', 2, { min: 1, max: 1000 }),
    fileRateBytesPerSec: fileRateMbps * 1024 * 1024,
    fileRateBurstBytes: fileBurstMb * 1024 * 1024,
    messageRateCapacity: readInt(env, 'MESSAGE_RATE_CAPACITY', 120, { min: 10, max: 10000 }),
    messageRateRefillPerSec: readInt(env, 'MESSAGE_RATE_REFILL_PER_SEC', 40, {
      min: 1,
      max: 10000,
    }),

    authAttemptLimit: readInt(env, 'AUTH_ATTEMPT_LIMIT', 30, { min: 1, max: 1000 }),
    authAttemptWindowMs: 60 * 1000,
    qrRateLimit: readInt(env, 'QR_RATE_LIMIT', 30, { min: 1, max: 1000 }),
    qrRateWindowMs: 60 * 1000,

    staticMaxAge: '1h',
  });
}

module.exports = { loadConfig, MIN_TOKEN_LENGTH };
