'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TransferRegistry, TransferError } = require('../src/transfers');

function createRegistry(now = () => 1000) {
  return new TransferRegistry({ maxActivePerClient: 2, idleTimeoutMs: 5000, now });
}

test('a transfer tracks bytes and finishes only at the declared size', () => {
  const transfers = createRegistry();
  const transfer = transfers.start({
    fileId: 'file-1',
    ownerId: 'peer-1',
    targetIds: ['peer-2'],
    name: 'photo.png',
    mime: 'image/png',
    size: 6,
  });

  transfers.addBytes(transfer, 3);
  assert.throws(
    () => transfers.finish('file-1', 'peer-1'),
    (error) => error instanceof TransferError && error.code === 'INCOMPLETE_FILE'
  );

  transfers.addBytes(transfer, 3);
  const finished = transfers.finish('file-1', 'peer-1');
  assert.equal(finished.receivedBytes, 6);
  assert.equal(transfers.size, 0);
});

test('transfers reject duplicate IDs, foreign owners and oversized chunks', () => {
  const transfers = createRegistry();
  const transfer = transfers.start({
    fileId: 'file-1',
    ownerId: 'peer-1',
    targetIds: ['peer-2'],
    name: 'file.bin',
    mime: 'application/octet-stream',
    size: 4,
  });

  assert.throws(
    () =>
      transfers.start({
        fileId: 'file-1',
        ownerId: 'peer-2',
        targetIds: [],
        name: 'other.bin',
        mime: 'application/octet-stream',
        size: 1,
      }),
    (error) => error.code === 'DUPLICATE_FILE_ID'
  );

  assert.throws(
    () => transfers.assertOwner('file-1', 'peer-2'),
    (error) => error.code === 'TRANSFER_FORBIDDEN'
  );

  transfers.addBytes(transfer, 4);
  assert.throws(
    () => transfers.addBytes(transfer, 1),
    (error) => error.code === 'FILE_TOO_LARGE'
  );
});

test('per-client active transfer limit is enforced', () => {
  const transfers = createRegistry();
  for (let index = 0; index < 2; index += 1) {
    transfers.start({
      fileId: `file-${index}`,
      ownerId: 'peer-1',
      targetIds: ['peer-2'],
      name: 'a.bin',
      mime: 'application/octet-stream',
      size: 1,
    });
  }

  assert.throws(
    () =>
      transfers.start({
        fileId: 'file-3',
        ownerId: 'peer-1',
        targetIds: ['peer-2'],
        name: 'a.bin',
        mime: 'application/octet-stream',
        size: 1,
      }),
    (error) => error.code === 'TOO_MANY_TRANSFERS'
  );
});

test('idle transfers expire and target removal can exhaust a transfer', () => {
  let now = 1000;
  const transfers = createRegistry(() => now);
  transfers.start({
    fileId: 'file-1',
    ownerId: 'peer-1',
    targetIds: ['peer-2'],
    name: 'a.bin',
    mime: 'application/octet-stream',
    size: 1,
  });

  now += 6000;
  const expired = transfers.sweep();
  assert.equal(expired.length, 1);
  assert.equal(transfers.size, 0);

  transfers.start({
    fileId: 'file-2',
    ownerId: 'peer-1',
    targetIds: ['peer-2'],
    name: 'a.bin',
    mime: 'application/octet-stream',
    size: 1,
  });
  const result = transfers.removeTarget('peer-2');
  assert.equal(result.exhausted.length, 1);
  assert.equal(transfers.size, 0);
});

test('cancelByOwner removes every active transfer for a disconnected sender', () => {
  const transfers = createRegistry();
  transfers.start({
    fileId: 'file-1',
    ownerId: 'peer-1',
    targetIds: ['peer-2'],
    name: 'a.bin',
    mime: 'application/octet-stream',
    size: 1,
  });
  transfers.start({
    fileId: 'file-2',
    ownerId: 'peer-1',
    targetIds: ['peer-2'],
    name: 'b.bin',
    mime: 'application/octet-stream',
    size: 1,
  });

  const cancelled = transfers.cancelByOwner('peer-1');
  assert.equal(cancelled.length, 2);
  assert.equal(transfers.size, 0);
});
