'use strict';
const mongoose = require('mongoose');
const logger   = require('../utils/logger');
const cfg      = require('../config');

async function connectMongo() {
  mongoose.connection.on('error',        e => logger.error('[DB] خطأ:', e.message));
  mongoose.connection.on('disconnected', () => logger.warn('[DB] انقطع الاتصال'));
  await mongoose.connect(cfg.mongoUri, { maxPoolSize: 20, serverSelectionTimeoutMS: 10_000 });
  logger.info('[DB] MongoDB متصل ✓');
}

module.exports = { connectMongo };
