'use strict';

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

function formatError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

function createLogger(level = 'info', sink = console) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(levelName, message, meta) {
    if (LEVELS[levelName] > threshold) return;
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${levelName.toUpperCase()} ${message}`;
    if (meta !== undefined) {
      const safeMeta =
        meta && typeof meta === 'object' && meta.error
          ? { ...meta, error: formatError(meta.error) }
          : meta;
      sink[levelName](line, safeMeta);
    } else {
      sink[levelName](line);
    }
  }

  return {
    error: (message, meta) => write('error', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    info: (message, meta) => write('info', message, meta),
    debug: (message, meta) => write('debug', message, meta),
  };
}

module.exports = { createLogger, LEVELS };
