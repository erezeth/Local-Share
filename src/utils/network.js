'use strict';

const os = require('node:os');

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

function getDisplayHost(config, lanIp = getLanIp()) {
  if (config.host && config.host !== '0.0.0.0' && config.host !== '::') return config.host;
  return lanIp;
}

function appendToken(url, token) {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

/**
 * The token is included in the join URL so a QR scan works without typing it.
 * The client moves it to sessionStorage and removes it from the address bar.
 */
function buildJoinUrl({ config, port, lanIp = getLanIp(), includeToken = true }) {
  let base = config.publicUrl;
  if (!base) {
    const protocol = config.tls ? 'https' : 'http';
    const host = getDisplayHost(config, lanIp);
    const defaultPort = protocol === 'https' ? 443 : 80;
    const portSuffix = port && Number(port) !== defaultPort ? `:${port}` : '';
    base = `${protocol}://${host}${portSuffix}`;
  }
  return includeToken && config.authRequired ? appendToken(base, config.accessToken) : base;
}

function originAllowed(origin, hostHeader, allowedOrigins, publicUrl) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (publicUrl && URL.canParse(publicUrl) && new URL(publicUrl).origin === origin) {
    return true;
  }
  if (!URL.canParse(origin)) return false;
  return new URL(origin).host === hostHeader;
}

module.exports = { getLanIp, getDisplayHost, appendToken, buildJoinUrl, originAllowed };
