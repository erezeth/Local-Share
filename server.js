'use strict';

const QRCode = require('qrcode');
const { createLocalShareServer } = require('./src/create-server');
const { buildJoinUrl } = require('./src/utils/network');

async function main() {
  const app = await createLocalShareServer();
  const address = await app.listen();
  const url = buildJoinUrl({ config: app.config, port: address.port });

  app.logger.info(`Local Share listening at ${url}`);
  if (app.config.authRequired) {
    if (app.config.tokenGenerated) {
      app.logger.info('Generated a new access token for this process');
    }
    app.logger.info(`Access token: ${app.config.accessToken}`);
    app.logger.info('Open the URL above, or scan its QR code, to join');
  } else {
    app.logger.warn('Authentication is disabled; only use this on a trusted network');
  }

  if (process.stdout.isTTY) {
    try {
      const qr = await QRCode.toString(url, { type: 'terminal', small: true });
      app.logger.info(`Scan to join from another device:\n${qr}`);
    } catch (error) {
      app.logger.warn('Unable to render the terminal QR code', { error });
    }
  }

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info(`Received ${signal}, shutting down gracefully`);

    const forceExit = setTimeout(() => {
      app.logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10000);
    forceExit.unref?.();

    try {
      await app.close();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      app.logger.error('Graceful shutdown failed', { error });
      clearTimeout(forceExit);
      process.exit(1);
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  console.error('[local-share] Unhandled rejection:', reason);
});

main().catch((error) => {
  console.error('[local-share] Failed to start:', error);
  process.exit(1);
});
