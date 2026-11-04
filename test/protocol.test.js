'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateClientMessage, ProtocolError } = require('../src/protocol');

const options = { maxNameLength: 20, maxChatLength: 2000, maxFileSize: 1024 };

test('auth accepts a bounded string token', () => {
  assert.deepEqual(validateClientMessage({ type: 'auth', token: 'abc' }), {
    type: 'auth',
    token: 'abc',
  });
  assert.throws(
    () => validateClientMessage({ type: 'auth', token: 123 }),
    (error) => error instanceof ProtocolError && error.code === 'INVALID_TOKEN'
  );
});

test('hello sanitizes the name and client ID', () => {
  assert.deepEqual(
    validateClientMessage(
      { type: 'hello', name: '  <b>Budi</b>  ', clientId: 'cid-123!?' },
      options
    ),
    { type: 'hello', name: 'bBudi/b', clientId: 'cid-123' }
  );
  assert.deepEqual(validateClientMessage({ type: 'hello', name: null }, options), {
    type: 'hello',
    name: null,
    clientId: '',
  });
});

test('chat requires text, caps it, and validates the target', () => {
  const message = validateClientMessage(
    { type: 'chat', text: '<b>hello</b>', target: 'peer 1!' },
    options
  );
  assert.deepEqual(message, {
    type: 'chat',
    text: '<b>hello</b>',
    targets: ['peer1'],
  });

  assert.throws(
    () => validateClientMessage({ type: 'chat', text: '   ' }, options),
    (error) => error.code === 'EMPTY_MESSAGE'
  );
  assert.throws(
    () => validateClientMessage({ type: 'chat', text: 'x', target: 42 }, options),
    (error) => error.code === 'INVALID_TARGET'
  );
  assert.throws(
    () => validateClientMessage({ type: 'chat', text: 'x', extra: true }, options),
    (error) => error.code === 'UNKNOWN_FIELD'
  );
});

test('file-start validates fileId, name, MIME and size', () => {
  const message = validateClientMessage(
    {
      type: 'file-start',
      fileId: 'file-1234',
      name: '../../photo.png',
      mime: 'IMAGE/PNG',
      size: 10,
      target: 'peer-1',
    },
    options
  );
  assert.deepEqual(message, {
    type: 'file-start',
    fileId: 'file-1234',
    name: 'photo.png',
    mime: 'image/png',
    size: 10,
    offset: 0,
    targets: ['peer-1'],
  });

  assert.throws(
    () =>
      validateClientMessage(
        { type: 'file-start', fileId: '../../x', name: 'a', mime: 'text/plain', size: 1 },
        options
      ),
    (error) => error.code === 'INVALID_FILE_ID'
  );
  assert.throws(
    () =>
      validateClientMessage(
        { type: 'file-start', fileId: 'file-1234', name: 'a', mime: 'text/plain', size: 2048 },
        options
      ),
    (error) => error.code === 'INVALID_FILE_SIZE'
  );
  assert.throws(
    () =>
      validateClientMessage(
        { type: 'file-start', fileId: 'file-1234', name: '', mime: 'text/plain', size: 1 },
        options
      ),
    (error) => error.code === 'INVALID_FILE_NAME'
  );
});

test('file-end and file-cancel require a valid fileId', () => {
  assert.deepEqual(validateClientMessage({ type: 'file-end', fileId: 'abcd' }, options), {
    type: 'file-end',
    fileId: 'abcd',
  });
  assert.throws(
    () => validateClientMessage({ type: 'file-end', fileId: 'x' }, options),
    (error) => error.code === 'INVALID_FILE_ID'
  );
  assert.throws(
    () => validateClientMessage({ type: 'file-cancel', fileId: 'x' }, options),
    (error) => error.code === 'INVALID_FILE_ID'
  );
});

test('chat and file-start accept multiple deduplicated targets and a resume offset', () => {
  assert.deepEqual(
    validateClientMessage(
      { type: 'chat', text: 'hi', targets: ['peer-1', 'peer-2', 'peer-1'] },
      options
    ),
    { type: 'chat', text: 'hi', targets: ['peer-1', 'peer-2'] }
  );

  assert.deepEqual(
    validateClientMessage(
      {
        type: 'file-start',
        fileId: 'file-1234',
        name: 'a.bin',
        mime: 'application/octet-stream',
        size: 10,
        offset: 4,
        targets: ['peer-1', 'peer-2'],
      },
      options
    ),
    {
      type: 'file-start',
      fileId: 'file-1234',
      name: 'a.bin',
      mime: 'application/octet-stream',
      size: 10,
      offset: 4,
      targets: ['peer-1', 'peer-2'],
    }
  );

  assert.throws(
    () =>
      validateClientMessage(
        {
          type: 'file-start',
          fileId: 'file-1234',
          name: 'a',
          mime: 'text/plain',
          size: 4,
          offset: 5,
        },
        options
      ),
    (error) => error.code === 'INVALID_OFFSET'
  );
  assert.throws(
    () => validateClientMessage({ type: 'chat', text: 'x', targets: 'peer-1' }, options),
    (error) => error.code === 'INVALID_TARGET'
  );
});

test('unknown and malformed messages are rejected', () => {
  assert.throws(
    () => validateClientMessage({ type: 'nope' }, options),
    (error) => error.code === 'UNKNOWN_TYPE'
  );
  assert.throws(
    () => validateClientMessage({ type: '__proto__' }, options),
    (error) => error.code === 'UNKNOWN_TYPE'
  );
  assert.throws(
    () => validateClientMessage([], options),
    (error) => error.code === 'INVALID_MESSAGE'
  );
  assert.throws(
    () => validateClientMessage({ text: 'missing type' }, options),
    (error) => error.code === 'INVALID_TYPE'
  );
});
