'use strict';
const { Redis } = require('ioredis');
const logger    = require('../utils/logger');

let _primary = null;

function getRedisConnection() {
  if (_primary) return _primary;
  _primary = new Redis({
    host:                 process.env.REDIS_HOST     || '127.0.0.1',
    port:                 parseInt(process.env.REDIS_PORT || '6379'),
    password:             process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck:     false,  // required by BullMQ
    lazyConnect:          true,
    retryStrategy: (times) => {
      if (times > 10) return null;
      return Math.min(times * 500, 5000);
    },
  });
  _primary.on('connect',      () => logger.info('[Redis] Connected'));
  _primary.on('error',   err  => logger.error(`[Redis] Error: ${err.message}`));
  _primary.on('reconnecting', () => logger.warn('[Redis] Reconnecting...'));
  return _primary;
}

// BullMQ requires a dedicated connection per Queue/Worker
function createConnection() {
  return getRedisConnection().duplicate();
}

async function closeRedis() {
  if (_primary) { await _primary.quit().catch(() => {}); _primary = null; }
}

module.exports = { getRedisConnection, createConnection, closeRedis };
