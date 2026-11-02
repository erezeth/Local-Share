'use strict';

const { WebSocketServer } = require('ws');
const { validateClientMessage, ProtocolError } = require('./protocol');
const { safeTokenEqual, TokenBucket, FixedWindowLimiter } = require('./security');
const { originAllowed } = require('./utils/network');
const { TransferError } = require('./transfers');
const { TargetError } = require('./state');

const CLOSE_CODES = Object.freeze({
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  RATE_LIMITED: 4429,
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
});

const MAX_PROTOCOL_VIOLATIONS = 20;
const MAX_PRE_AUTH_MESSAGES = 20;

function setupWebSocket({ server, config, logger, registry, transfers }) {
  const wss = new WebSocketServer({
    server,
    maxPayload: config.wsMaxPayload,
    perMessageDeflate: false,
  });

  const authAttempts = new FixedWindowLimiter({
    limit: config.authAttemptLimit,
    windowMs: config.authAttemptWindowMs,
  });

  let closed = false;

  function closeSocket(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch (error) {
      logger.warn('Failed to close WebSocket', { error, code, reason });
    }
  }

  function sendError(client, code, message, extra = {}) {
    registry.send(client, { type: 'error', code, message, ...extra });
  }

  function broadcastUsers() {
    registry.broadcast({ type: 'users', users: registry.listUsers() });
  }

  function notifyTransferTargets(transfer, payload) {
    for (const targetId of transfer.targetIds) {
      const target = registry.getById(targetId);
      if (target) registry.send(target, payload);
    }
  }

  function abortTransfer(client, transfer, code, message) {
    try {
      transfers.cancel(transfer.fileId, client.id);
    } catch (error) {
      if (!(error instanceof TransferError) || error.code !== 'UNKNOWN_TRANSFER') {
        logger.warn('Failed to cancel transfer', { error, fileId: transfer.fileId });
      }
    }
    notifyTransferTargets(transfer, {
      type: 'file-cancel',
      fileId: transfer.fileId,
      from: client.name,
      fromId: client.id,
      reason: code.toLowerCase(),
    });
    sendError(client, code, message, { fileId: transfer.fileId });
    logger.warn('Aborted file transfer', {
      fileId: transfer.fileId,
      ownerId: client.id,
      code,
    });
  }

  function closeWithAuthError(ws, client, message, code = CLOSE_CODES.UNAUTHORIZED) {
    if (client.authTimer) {
      clearTimeout(client.authTimer);
      client.authTimer = null;
    }
    if (ws.readyState !== 1) {
      closeSocket(ws, code, message);
      return;
    }
    const payload = JSON.stringify({ type: 'auth-error', code: 'AUTH_FAILED', message });
    try {
      ws.send(payload, () => closeSocket(ws, code, message));
    } catch (error) {
      logger.warn('Failed to send authentication error', { error, clientId: client.id });
      closeSocket(ws, code, message);
    }
  }

  wss.on('connection', (ws, req) => {
    if (closed) {
      closeSocket(ws, CLOSE_CODES.GOING_AWAY, 'Server is shutting down');
      return;
    }

    const ip = req.socket.remoteAddress || 'unknown';
    if (
      !originAllowed(req.headers.origin, req.headers.host, config.allowedOrigins, config.publicUrl)
    ) {
      logger.warn('Rejected WebSocket connection from a disallowed origin', {
        origin: req.headers.origin,
        host: req.headers.host,
        ip,
      });
      closeSocket(ws, CLOSE_CODES.FORBIDDEN, 'Origin not allowed');
      return;
    }

    let client;
    try {
      client = registry.add(ws, { ip });
    } catch (error) {
      logger.warn('Rejected WebSocket connection', { error, ip });
      closeSocket(ws, 1013, 'Server is full');
      return;
    }

    client.chatBucket = new TokenBucket({
      capacity: config.chatRateCapacity,
      refillPerSecond: config.chatRateRefillPerSec,
    });
    client.fileBucket = new TokenBucket({
      capacity: config.fileRateBurstBytes,
      refillPerSecond: config.fileRateBytesPerSec,
    });
    client.messageBucket = new TokenBucket({
      capacity: config.messageRateCapacity,
      refillPerSecond: config.messageRateRefillPerSec,
    });
    client.preAuthMessages = 0;
    client.authTimer = null;

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    if (config.authRequired) {
      client.authTimer = setTimeout(() => {
        if (!client.authorized) {
          logger.warn('WebSocket authentication timed out', { clientId: client.id, ip });
          closeWithAuthError(ws, client, 'Authentication timed out');
        }
      }, config.authTimeoutMs);
      client.authTimer.unref?.();
    } else {
      client.authorized = true;
    }

    function noteProtocolViolation(clientRef, error) {
      sendError(clientRef, error.code || 'INVALID_MESSAGE', error.message);
      clientRef.protocolViolations += 1;
      if (clientRef.protocolViolations > MAX_PROTOCOL_VIOLATIONS) {
        logger.warn('Closing client after too many invalid messages', {
          clientId: clientRef.id,
        });
        closeSocket(ws, CLOSE_CODES.POLICY_VIOLATION, 'Too many invalid messages');
      }
    }

    function markAuthorized() {
      if (client.authTimer) {
        clearTimeout(client.authTimer);
        client.authTimer = null;
      }
      client.authorized = true;
      registry.send(client, {
        type: 'auth-ok',
        authRequired: config.authRequired,
        limits: {
          maxFileSize: config.maxFileSize,
          maxChatLength: config.maxChatLength,
          maxNameLength: config.maxNameLength,
        },
      });
    }

    function handleAuth(message) {
      if (!config.authRequired) {
        markAuthorized();
        return;
      }

      if (!authAttempts.take(ip)) {
        logger.warn('Authentication rate limit exceeded', { ip });
        closeWithAuthError(
          ws,
          client,
          'Too many authentication attempts; try again later',
          CLOSE_CODES.RATE_LIMITED
        );
        return;
      }

      if (!safeTokenEqual(message.token, config.accessToken)) {
        logger.warn('WebSocket authentication failed', { ip, clientId: client.id });
        closeWithAuthError(ws, client, 'Invalid access token');
        return;
      }

      logger.info('WebSocket client authenticated', { clientId: client.id, ip });
      markAuthorized();
    }

    function handleHello(message) {
      const remembered = message.clientId ? registry.nameForClientId(message.clientId) : null;
      const name = message.name || remembered || client.name;
      if (!name) {
        registry.send(client, { type: 'need-name' });
        return;
      }

      registry.setName(client, name);
      if (message.clientId) registry.rememberName(message.clientId, name);
      registry.send(client, { type: 'welcome', id: client.id, name });
      broadcastUsers();
    }

    function handleGuest(message) {
      const remembered = message.clientId ? registry.nameForClientId(message.clientId) : null;
      let name = remembered && /^user-\d+$/.test(remembered) ? remembered : null;
      if (!name) name = registry.nextGuestName();

      registry.setName(client, name);
      if (message.clientId) registry.rememberName(message.clientId, name);
      registry.send(client, { type: 'welcome', id: client.id, name });
      broadcastUsers();
    }

    function handleChat(message) {
      const rate = client.chatBucket.consume(1);
      if (!rate.allowed) {
        sendError(client, 'RATE_LIMITED', 'You are sending messages too quickly', {
          retryAfterMs: rate.retryAfterMs,
        });
        return;
      }

      let recipients;
      try {
        recipients = registry.recipientsFor(message.target, { exceptId: client.id });
      } catch (error) {
        if (error instanceof TargetError) {
          sendError(client, error.code, error.message);
          return;
        }
        throw error;
      }

      const payload = {
        type: 'chat',
        from: client.name,
        fromId: client.id,
        text: message.text,
        ts: Date.now(),
      };
      if (message.target) payload.target = message.target;

      for (const recipient of recipients) {
        registry.send(recipient, payload);
      }
      logger.debug('Chat relayed', {
        fromId: client.id,
        target: message.target || 'all',
        recipients: recipients.length,
      });
    }

    function handleFileStart(message) {
      let recipients;
      try {
        recipients = registry.recipientsFor(message.target, { exceptId: client.id });
      } catch (error) {
        if (error instanceof TargetError) {
          sendError(client, error.code, error.message, { fileId: message.fileId });
          return;
        }
        throw error;
      }

      if (recipients.length === 0) {
        registry.send(client, {
          type: 'file-start-ack',
          fileId: message.fileId,
          recipients: 0,
          target: message.target || null,
        });
        return;
      }

      let transfer;
      try {
        transfer = transfers.start({
          fileId: message.fileId,
          ownerId: client.id,
          targetIds: recipients.map((recipient) => recipient.id),
          name: message.name,
          mime: message.mime,
          size: message.size,
        });
      } catch (error) {
        if (error instanceof TransferError) {
          sendError(client, error.code, error.message, { fileId: message.fileId });
          return;
        }
        throw error;
      }

      const payload = {
        type: 'file-start',
        fileId: transfer.fileId,
        from: client.name,
        fromId: client.id,
        name: transfer.name,
        mime: transfer.mime,
        size: transfer.size,
      };
      let delivered = 0;
      for (const recipient of recipients) {
        if (registry.send(recipient, payload)) delivered += 1;
      }

      if (delivered === 0) {
        transfers.cancel(transfer.fileId, client.id);
        registry.send(client, {
          type: 'file-start-ack',
          fileId: message.fileId,
          recipients: 0,
          target: message.target || null,
        });
        return;
      }

      registry.send(client, {
        type: 'file-start-ack',
        fileId: message.fileId,
        recipients: delivered,
        target: message.target || null,
      });
      logger.debug('File transfer started', {
        fileId: transfer.fileId,
        ownerId: client.id,
        recipients: delivered,
        size: transfer.size,
      });
    }

    function handleFileEnd(message) {
      let transfer;
      try {
        transfer = transfers.finish(message.fileId, client.id);
      } catch (error) {
        if (!(error instanceof TransferError)) throw error;
        if (error.code === 'INCOMPLETE_FILE') {
          const current = transfers.get(message.fileId);
          if (current) {
            abortTransfer(client, current, error.code, error.message);
          } else {
            sendError(client, error.code, error.message, { fileId: message.fileId });
          }
          return;
        }
        sendError(client, error.code, error.message, { fileId: message.fileId });
        return;
      }

      notifyTransferTargets(transfer, {
        type: 'file-end',
        fileId: transfer.fileId,
        from: client.name,
        fromId: client.id,
        size: transfer.size,
      });
      registry.send(client, { type: 'file-end-ack', fileId: transfer.fileId });
      logger.debug('File transfer finished', {
        fileId: transfer.fileId,
        ownerId: client.id,
        bytes: transfer.receivedBytes,
      });
    }

    function handleFileCancel(message) {
      let transfer;
      try {
        transfer = transfers.cancel(message.fileId, client.id);
      } catch (error) {
        if (error instanceof TransferError) {
          sendError(client, error.code, error.message, { fileId: message.fileId });
          return;
        }
        throw error;
      }

      notifyTransferTargets(transfer, {
        type: 'file-cancel',
        fileId: transfer.fileId,
        from: client.name,
        fromId: client.id,
        reason: 'sender-cancelled',
      });
    }

    function handleBinary(data) {
      if (!client.authorized) {
        closeWithAuthError(ws, client, 'Authentication required');
        return;
      }

      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buffer.length < 2) {
        sendError(client, 'INVALID_CHUNK', 'Binary chunk is too short');
        return;
      }

      const idLength = buffer[0];
      if (idLength < 4 || idLength > 32 || buffer.length < 1 + idLength) {
        sendError(client, 'INVALID_CHUNK', 'Binary chunk header is invalid');
        return;
      }

      const fileId = buffer.toString('ascii', 1, 1 + idLength);
      if (!/^[A-Za-z0-9_-]{4,32}$/.test(fileId)) {
        sendError(client, 'INVALID_FILE_ID', 'Binary chunk fileId is invalid');
        return;
      }

      let transfer;
      try {
        transfer = transfers.assertOwner(fileId, client.id);
      } catch (error) {
        if (error instanceof TransferError) {
          sendError(client, error.code, error.message, { fileId });
          return;
        }
        throw error;
      }

      const chunkBytes = buffer.length - 1 - idLength;
      const rate = client.fileBucket.consume(buffer.length);
      if (!rate.allowed) {
        abortTransfer(client, transfer, 'RATE_LIMITED', 'File transfer rate limit exceeded');
        return;
      }

      try {
        transfers.addBytes(transfer, chunkBytes);
      } catch (error) {
        if (error instanceof TransferError) {
          abortTransfer(client, transfer, error.code, error.message);
          return;
        }
        throw error;
      }

      for (const targetId of transfer.targetIds) {
        const target = registry.getById(targetId);
        if (!target) continue;

        if (target.ws.bufferedAmount > config.wsMaxBufferedBytes) {
          logger.warn('Closing slow WebSocket client', {
            clientId: target.id,
            bufferedAmount: target.ws.bufferedAmount,
          });
          closeSocket(target.ws, 1013, 'Client is too slow');
          continue;
        }

        registry.sendRaw(target, buffer, { binary: true });
      }
    }

    function handleJson(data) {
      if (client.authorized) {
        const messageRate = client.messageBucket.consume(1);
        if (!messageRate.allowed) {
          sendError(client, 'RATE_LIMITED', 'Too many messages', {
            retryAfterMs: messageRate.retryAfterMs,
          });
          return;
        }
      } else {
        client.preAuthMessages += 1;
        if (client.preAuthMessages > MAX_PRE_AUTH_MESSAGES) {
          closeWithAuthError(
            ws,
            client,
            'Too many messages before authentication',
            CLOSE_CODES.RATE_LIMITED
          );
          return;
        }
      }

      let raw;
      try {
        raw = JSON.parse(data.toString('utf8'));
      } catch (error) {
        logger.debug('Rejected invalid JSON message', { clientId: client.id, error });
        sendError(client, 'INVALID_JSON', 'Message must be valid JSON');
        return;
      }

      let message;
      try {
        message = validateClientMessage(raw, {
          maxNameLength: config.maxNameLength,
          maxChatLength: config.maxChatLength,
          maxFileSize: config.maxFileSize,
        });
      } catch (error) {
        if (error instanceof ProtocolError) {
          noteProtocolViolation(client, error);
          return;
        }
        throw error;
      }

      if (!client.authorized) {
        if (message.type !== 'auth') {
          closeWithAuthError(ws, client, 'Authentication required');
          return;
        }
        handleAuth(message);
        return;
      }

      switch (message.type) {
        case 'auth':
          markAuthorized();
          break;
        case 'hello':
          handleHello(message);
          break;
        case 'guest':
          handleGuest(message);
          break;
        case 'ping':
          registry.send(client, { type: 'pong', ts: Date.now() });
          break;
        case 'chat':
          handleChat(message);
          break;
        case 'file-start':
          handleFileStart(message);
          break;
        case 'file-end':
          handleFileEnd(message);
          break;
        case 'file-cancel':
          handleFileCancel(message);
          break;
        default:
          sendError(client, 'UNKNOWN_TYPE', 'Unknown message type');
      }
    }

    ws.on('message', (data, isBinary) => {
      if (closed) return;
      try {
        if (isBinary) handleBinary(data);
        else handleJson(data);
      } catch (error) {
        logger.error('Unhandled WebSocket message error', {
          error,
          clientId: client.id,
        });
        sendError(client, 'INTERNAL_ERROR', 'The server could not process this message');
      }
    });

    ws.on('close', (code, reason) => {
      if (client.authTimer) {
        clearTimeout(client.authTimer);
        client.authTimer = null;
      }
      const removed = registry.remove(client);
      if (!removed) return;

      for (const transfer of transfers.cancelByOwner(client.id)) {
        notifyTransferTargets(transfer, {
          type: 'file-cancel',
          fileId: transfer.fileId,
          from: client.name,
          fromId: client.id,
          reason: 'sender-disconnected',
        });
      }

      const { exhausted } = transfers.removeTarget(client.id);
      for (const transfer of exhausted) {
        const owner = registry.getById(transfer.ownerId);
        if (owner) {
          sendError(owner, 'NO_RECIPIENTS', 'All recipients disconnected', {
            fileId: transfer.fileId,
          });
        }
      }

      broadcastUsers();
      logger.info('WebSocket client disconnected', {
        clientId: client.id,
        name: client.name,
        ip: client.ip,
        code,
        reason: reason?.toString() || '',
      });
    });

    ws.on('error', (error) => {
      logger.warn('WebSocket connection error', { error, clientId: client.id, ip });
    });
  });

  wss.on('error', (error) => {
    logger.error('WebSocket server error', { error });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        logger.warn('Terminating unresponsive WebSocket client');
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (error) {
        logger.warn('Failed to send WebSocket ping', { error });
      }
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  const sweep = setInterval(
    () => {
      for (const transfer of transfers.sweep()) {
        const owner = registry.getById(transfer.ownerId);
        const payload = {
          type: 'file-cancel',
          fileId: transfer.fileId,
          from: owner?.name,
          fromId: transfer.ownerId,
          reason: 'timeout',
        };
        notifyTransferTargets(transfer, payload);
        if (owner) {
          sendError(owner, 'TRANSFER_TIMEOUT', 'File transfer expired while idle', {
            fileId: transfer.fileId,
          });
        }
        logger.warn('Expired idle file transfer', {
          fileId: transfer.fileId,
          ownerId: transfer.ownerId,
        });
      }
    },
    Math.max(5000, Math.min(30000, Math.floor(config.transferIdleTimeoutMs / 2)))
  );
  sweep.unref?.();

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    clearInterval(heartbeat);
    clearInterval(sweep);

    for (const ws of wss.clients) {
      closeSocket(ws, CLOSE_CODES.GOING_AWAY, 'Server shutting down');
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        for (const ws of wss.clients) {
          try {
            ws.terminate();
          } catch (error) {
            logger.warn('Failed to terminate WebSocket during shutdown', { error });
          }
        }
        resolve();
      }, 2000);
      timeout.unref?.();

      wss.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  return { wss, close };
}

module.exports = { setupWebSocket, CLOSE_CODES };
