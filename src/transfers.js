'use strict';

class TransferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
  }
}

class TransferRegistry {
  constructor({ maxActivePerClient = 3, idleTimeoutMs = 60000, now = Date.now } = {}) {
    this.maxActivePerClient = maxActivePerClient;
    this.idleTimeoutMs = idleTimeoutMs;
    this.now = now;
    this.transfers = new Map();
  }

  get size() {
    return this.transfers.size;
  }

  start({ fileId, ownerId, targetIds, name, mime, size }) {
    if (this.transfers.has(fileId)) {
      throw new TransferError('DUPLICATE_FILE_ID', 'A transfer with this fileId already exists');
    }

    let activeForOwner = 0;
    for (const transfer of this.transfers.values()) {
      if (transfer.ownerId === ownerId) activeForOwner += 1;
    }
    if (activeForOwner >= this.maxActivePerClient) {
      throw new TransferError(
        'TOO_MANY_TRANSFERS',
        `At most ${this.maxActivePerClient} active transfers are allowed`
      );
    }

    const timestamp = this.now();
    const transfer = {
      fileId,
      ownerId,
      targetIds: new Set(targetIds),
      name,
      mime,
      size,
      receivedBytes: 0,
      chunks: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.transfers.set(fileId, transfer);
    return transfer;
  }

  get(fileId) {
    return this.transfers.get(fileId) || null;
  }

  assertOwner(fileId, ownerId) {
    const transfer = this.get(fileId);
    if (!transfer) {
      throw new TransferError('UNKNOWN_TRANSFER', 'Unknown or expired file transfer');
    }
    if (transfer.ownerId !== ownerId) {
      throw new TransferError('TRANSFER_FORBIDDEN', 'This file transfer belongs to another client');
    }
    return transfer;
  }

  addBytes(transfer, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new TransferError('INVALID_CHUNK', 'Chunk must contain at least one byte');
    }
    if (transfer.receivedBytes + bytes > transfer.size) {
      throw new TransferError('FILE_TOO_LARGE', 'Received more data than declared');
    }
    transfer.receivedBytes += bytes;
    transfer.chunks += 1;
    transfer.updatedAt = this.now();
    return transfer;
  }

  finish(fileId, ownerId) {
    const transfer = this.assertOwner(fileId, ownerId);
    if (transfer.receivedBytes !== transfer.size) {
      throw new TransferError(
        'INCOMPLETE_FILE',
        `Received ${transfer.receivedBytes} of ${transfer.size} bytes`
      );
    }
    this.transfers.delete(fileId);
    return transfer;
  }

  cancel(fileId, ownerId) {
    const transfer = this.assertOwner(fileId, ownerId);
    this.transfers.delete(fileId);
    return transfer;
  }

  cancelByOwner(ownerId) {
    const cancelled = [];
    for (const [fileId, transfer] of this.transfers) {
      if (transfer.ownerId === ownerId) {
        this.transfers.delete(fileId);
        cancelled.push(transfer);
      }
    }
    return cancelled;
  }

  removeTarget(targetId) {
    const affected = [];
    const exhausted = [];
    for (const [fileId, transfer] of this.transfers) {
      if (!transfer.targetIds.delete(targetId)) continue;
      affected.push(transfer);
      // A transfer without recipients can no longer deliver data anywhere.
      if (transfer.targetIds.size === 0) {
        this.transfers.delete(fileId);
        exhausted.push(transfer);
      }
    }
    return { affected, exhausted };
  }

  sweep(now = this.now()) {
    const expired = [];
    for (const [fileId, transfer] of this.transfers) {
      if (now - transfer.updatedAt > this.idleTimeoutMs) {
        this.transfers.delete(fileId);
        expired.push(transfer);
      }
    }
    return expired;
  }

  clear() {
    this.transfers.clear();
  }
}

module.exports = { TransferRegistry, TransferError };
