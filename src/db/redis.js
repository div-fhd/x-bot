'use strict';
const logger = require('../utils/logger');
let client = null;

async function connectRedis() {
  const url = process.env.REDIS_URL
    || (process.env.REDIS_HOST
        ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}`
        : 'redis://127.0.0.1:6379');
  logger.info(`[Redis] Connecting to ${url}`);
  try {
    const Redis = require('ioredis');
    client = new Redis(url, {
      password: process.env.REDIS_URL ? undefined : (process.env.REDIS_PASSWORD || undefined),
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

async function disconnectRedis() {
  if (!client) return;
  const current = client;
  client = null;
  try {
    await current.quit();
  } catch (_) {
    current.disconnect();
  }
}

module.exports = { connectRedis, getRedis, disconnectRedis };
