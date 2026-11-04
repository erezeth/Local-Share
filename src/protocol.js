'use strict';

const {
  sanitizeName,
  sanitizeText,
  sanitizeFileName,
  sanitizeId,
  isValidFileId,
  normalizeMime,
} = require('./security');

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const ALLOWED_KEYS = Object.freeze({
  auth: new Set(['type', 'token']),
  hello: new Set(['type', 'clientId', 'name']),
  guest: new Set(['type', 'clientId']),
  ping: new Set(['type']),
  chat: new Set(['type', 'text', 'target', 'targets']),
  'file-start': new Set(['type', 'fileId', 'name', 'mime', 'size', 'target', 'targets', 'offset']),
  'file-end': new Set(['type', 'fileId']),
  'file-cancel': new Set(['type', 'fileId']),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoUnknownKeys(raw, allowedKeys) {
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new ProtocolError('UNKNOWN_FIELD', `Field "${key}" is not allowed for this message`);
    }
  }
}

function optionalTargets(raw) {
  const values = [];
  if (raw.target !== undefined && raw.target !== null && raw.target !== '') {
    values.push(raw.target);
  }
  if (raw.targets !== undefined) {
    if (!Array.isArray(raw.targets)) {
      throw new ProtocolError('INVALID_TARGET', 'targets must be an array');
    }
    if (raw.targets.length > 100) {
      throw new ProtocolError('INVALID_TARGET', 'targets contains too many recipients');
    }
    values.push(...raw.targets);
  }

  const targets = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new ProtocolError('INVALID_TARGET', 'target must be a string');
    }
    const target = sanitizeId(value, 64);
    if (!target) throw new ProtocolError('INVALID_TARGET', 'target is invalid');
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

function optionalClientId(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new ProtocolError('INVALID_CLIENT_ID', 'clientId must be a string');
  }
  return sanitizeId(value, 64);
}

function requireFileId(value) {
  if (!isValidFileId(value)) {
    throw new ProtocolError('INVALID_FILE_ID', 'fileId must be 4-32 alphanumeric characters');
  }
  return value;
}

function validateClientMessage(raw, options = {}) {
  const maxNameLength = options.maxNameLength ?? 20;
  const maxChatLength = options.maxChatLength ?? 2000;
  const maxFileSize = options.maxFileSize ?? 100 * 1024 * 1024;

  if (!isPlainObject(raw)) {
    throw new ProtocolError('INVALID_MESSAGE', 'Message must be a JSON object');
  }
  if (typeof raw.type !== 'string' || !raw.type) {
    throw new ProtocolError('INVALID_TYPE', 'Message type is required');
  }

  const allowedKeys = Object.prototype.hasOwnProperty.call(ALLOWED_KEYS, raw.type)
    ? ALLOWED_KEYS[raw.type]
    : null;
  if (!allowedKeys) {
    throw new ProtocolError('UNKNOWN_TYPE', `Unknown message type "${raw.type}"`);
  }
  assertNoUnknownKeys(raw, allowedKeys);

  switch (raw.type) {
    case 'auth': {
      if (typeof raw.token !== 'string' || raw.token.length > 512) {
        throw new ProtocolError(
          'INVALID_TOKEN',
          'token must be a string of at most 512 characters'
        );
      }
      return { type: 'auth', token: raw.token };
    }

    case 'hello': {
      if (raw.name !== undefined && raw.name !== null && typeof raw.name !== 'string') {
        throw new ProtocolError('INVALID_NAME', 'name must be a string or null');
      }
      const name = raw.name ? sanitizeName(raw.name, maxNameLength) : '';
      return {
        type: 'hello',
        name: name || null,
        clientId: optionalClientId(raw.clientId),
      };
    }

    case 'guest':
      return { type: 'guest', clientId: optionalClientId(raw.clientId) };

    case 'ping':
      return { type: 'ping' };

    case 'chat': {
      if (typeof raw.text !== 'string') {
        throw new ProtocolError('INVALID_TEXT', 'text must be a string');
      }
      const text = sanitizeText(raw.text, maxChatLength);
      if (!text) throw new ProtocolError('EMPTY_MESSAGE', 'chat text is empty');
      return { type: 'chat', text, targets: optionalTargets(raw) };
    }

    case 'file-start': {
      const fileId = requireFileId(raw.fileId);
      if (typeof raw.name !== 'string' || !raw.name.trim()) {
        throw new ProtocolError('INVALID_FILE_NAME', 'file name is required');
      }
      const name = sanitizeFileName(raw.name);
      if (!name) throw new ProtocolError('INVALID_FILE_NAME', 'file name is invalid');
      if (!Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > maxFileSize) {
        throw new ProtocolError(
          'INVALID_FILE_SIZE',
          `file size must be between 0 and ${maxFileSize} bytes`
        );
      }
      const offset = raw.offset === undefined ? 0 : raw.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > raw.size) {
        throw new ProtocolError('INVALID_OFFSET', 'offset must be within the declared file size');
      }
      return {
        type: 'file-start',
        fileId,
        name,
        mime: normalizeMime(raw.mime),
        size: raw.size,
        offset,
        targets: optionalTargets(raw),
      };
    }

    case 'file-end':
      return { type: 'file-end', fileId: requireFileId(raw.fileId) };

    case 'file-cancel':
      return { type: 'file-cancel', fileId: requireFileId(raw.fileId) };

    default:
      throw new ProtocolError('UNKNOWN_TYPE', `Unknown message type "${raw.type}"`);
  }
}

module.exports = { ProtocolError, validateClientMessage };
