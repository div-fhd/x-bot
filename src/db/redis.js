'use strict';
const logger = require('../utils/logger');
let client = null;

async function connectRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn('[Redis] REDIS_URL not set — Redis disabled');
    return null;
  }
  try {
    const Redis = require('ioredis');
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      connectTimeout: 5000,
      retryStrategy: (times) => times > 3 ? null : 1000 * times, // stop after 3 retries
    });
    await new Promise((resolve, reject) => {
      client.once('ready', () => { logger.info('[Redis] Connected'); resolve(); });
      client.once('error', reject);
      setTimeout(reject, 5000);
    });
    client.on('error', e => logger.warn(`[Redis] ${e.message}`));
    return client;
  } catch (e) {
    logger.warn(`[Redis] Could not connect (${e.message}) — continuing without Redis`);
    client = null;
    return null;
  }
}

const getRedis = () => client;
module.exports = { connectRedis, getRedis };
