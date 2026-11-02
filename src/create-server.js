'use strict';

const http = require('node:http');
const https = require('node:https');
const { readFile } = require('node:fs/promises');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { ClientRegistry } = require('./state');
const { TransferRegistry } = require('./transfers');
const { createApp } = require('./routes');
const { setupWebSocket } = require('./websocket');

async function loadTlsOptions(config) {
  if (!config.tls) return null;

  try {
    const [key, cert] = await Promise.all([
      readFile(config.tls.keyPath),
      readFile(config.tls.certPath),
    ]);
    return { key, cert };
  } catch (error) {
    throw new Error(`Unable to read TLS_KEY/TLS_CERT: ${error.message}`, { cause: error });
  }
}

async function createLocalShareServer({ env = process.env, logger: injectedLogger } = {}) {
  const config = loadConfig(env);
  const logger = injectedLogger || createLogger(config.logLevel);

  if (!config.authRequired) {
    logger.warn('AUTH_DISABLED=true: WebSocket connections are not authenticated');
  }

  const registry = new ClientRegistry({
    logger,
    maxClients: config.maxClients,
  });
  const transfers = new TransferRegistry({
    maxActivePerClient: config.maxActiveTransfers,
    idleTimeoutMs: config.transferIdleTimeoutMs,
  });
  const app = createApp({
    config,
    logger,
    getClientCount: () => registry.size,
  });

  let server;
  const tlsOptions = await loadTlsOptions(config);
  if (tlsOptions) {
    server = https.createServer(tlsOptions, app);
    logger.info('HTTPS/WSS mode enabled');
  } else {
    server = http.createServer(app);
  }

  const websocket = setupWebSocket({ server, config, logger, registry, transfers });

  let closingPromise = null;
  let listening = false;

  function listen(port = config.port, host = config.host) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        listening = true;
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  function close() {
    if (closingPromise) return closingPromise;

    closingPromise = (async () => {
      await websocket.close();

      await new Promise((resolve) => {
        if (!listening || !server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // Static HTTP requests are short-lived; close keep-alives so shutdown is prompt.
        server.closeAllConnections?.();
      });

      transfers.clear();
      registry.clear();
      listening = false;
    })();

    return closingPromise;
  }

  server.on('error', (error) => {
    logger.error('HTTP server error', { error });
  });

  return {
    config,
    logger,
    app,
    server,
    wss: websocket.wss,
    registry,
    transfers,
    listen,
    close,
  };
}

module.exports = { createLocalShareServer };
