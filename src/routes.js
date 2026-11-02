'use strict';

const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const { safeTokenEqual, FixedWindowLimiter } = require('./security');
const { buildJoinUrl } = require('./utils/network');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function extractAccessToken(req) {
  const headerToken = req.get('x-access-token');
  if (headerToken) return headerToken.trim();

  const authorization = req.get('authorization');
  if (authorization && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, '').trim();
  }

  const queryToken = req.query.token;
  return typeof queryToken === 'string' ? queryToken : '';
}

function requireAccessToken(config) {
  return (req, res, next) => {
    if (!config.authRequired) return next();
    const token = extractAccessToken(req);
    if (!token || !safeTokenEqual(token, config.accessToken)) {
      res.set('Cache-Control', 'no-store');
      return res
        .status(401)
        .json({ error: 'unauthorized', message: 'A valid access token is required' });
    }
    return next();
  };
}

function securityHeaders(config) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (config.tls) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

function createApp({ config, logger, getClientCount = () => 0 }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  const qrLimiter = new FixedWindowLimiter({
    limit: config.qrRateLimit,
    windowMs: config.qrRateWindowMs,
  });

  app.use(securityHeaders(config));

  const qrRateLimit = (req, res, next) => {
    if (!qrLimiter.take(req.ip || req.socket.remoteAddress || 'unknown')) {
      res.set('Retry-After', String(Math.ceil(config.qrRateWindowMs / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    return next();
  };

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      authRequired: config.authRequired,
      clients: getClientCount(),
    });
  });

  app.get('/qr', qrRateLimit, requireAccessToken(config), async (req, res) => {
    try {
      const port = req.socket.localPort || config.port;
      const url = buildJoinUrl({ config, port });
      const qr = await QRCode.toDataURL(url, {
        margin: 1,
        width: 300,
        errorCorrectionLevel: 'M',
      });
      res.set('Cache-Control', 'no-store');
      return res.json({ url, qr });
    } catch (error) {
      logger.error('Failed to generate QR code', { error, ip: req.ip });
      return res.status(500).json({ error: 'qr_generation_failed' });
    }
  });

  app.use(
    express.static(PUBLIC_DIR, {
      maxAge: config.staticMaxAge,
      index: 'index.html',
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html') || filePath.endsWith('app.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  app.use((error, req, res, _next) => {
    logger.error('Unhandled HTTP request error', {
      error,
      method: req.method,
      path: req.path,
    });
    if (res.headersSent) return _next(error);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp, requireAccessToken, extractAccessToken, securityHeaders };
