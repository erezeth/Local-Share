'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const ZERO_WIDTH_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{4,32}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/**
 * Names are rendered with textContent on the client, but server-side
 * normalization keeps them bounded and free of control characters.
 */
function sanitizeName(value, maxLength = 20) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(ZERO_WIDTH_CHARS, '')
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Chat text may contain markup; the client renders it with textContent. */
function sanitizeText(value, maxLength = 2000) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function sanitizeFileName(value, maxLength = 120) {
  const raw = String(value ?? '')
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(/[\\/]+/g, '/');
  const base = path.posix
    .basename(raw)
    .replace(/[<>:"|?*]/g, '')
    .trim();
  return (base || 'file').slice(0, maxLength);
}

function sanitizeId(value, maxLength = 64) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, maxLength);
}

function isValidFileId(value) {
  return typeof value === 'string' && FILE_ID_PATTERN.test(value);
}

function normalizeMime(value) {
  const mime = String(value ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 100);
  return MIME_PATTERN.test(mime) ? mime : 'application/octet-stream';
}

function safeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

class TokenBucket {
  constructor({ capacity, refillPerSecond, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.updatedAt = now();
  }

  consume(cost = 1) {
    const now = this.now();
    const elapsedSeconds = Math.max(0, (now - this.updatedAt) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.updatedAt = now;

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, retryAfterMs: 0 };
    }

    const missing = cost - this.tokens;
    const retryAfterMs =
      this.refillPerSecond > 0
        ? Math.max(1, Math.ceil((missing / this.refillPerSecond) * 1000))
        : 60000;
    return { allowed: false, retryAfterMs };
  }
}

class FixedWindowLimiter {
  constructor({ limit, windowMs, now = Date.now, maxKeys = 10000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    this.entries = new Map();
    this.calls = 0;
  }

  take(key, cost = 1) {
    const now = this.now();
    const current = this.entries.get(key);
    let entry = current;

    if (!entry || now - entry.windowStart >= this.windowMs) {
      entry = { windowStart: now, count: 0 };
      this.entries.set(key, entry);
    }

    if (entry.count + cost > this.limit) {
      return false;
    }

    entry.count += cost;
    this.calls += 1;
    if (this.entries.size > this.maxKeys) this.cleanup(now);
    else if (this.calls % 1000 === 0) this.cleanup(now);
    return true;
  }

  cleanup(now = this.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart >= this.windowMs) this.entries.delete(key);
    }
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

module.exports = {
  sanitizeName,
  sanitizeText,
  sanitizeFileName,
  sanitizeId,
  isValidFileId,
  normalizeMime,
  safeTokenEqual,
  TokenBucket,
  FixedWindowLimiter,
};
