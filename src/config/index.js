'use strict';
require('dotenv').config();

const required = ['VAULT_KEY', 'APP_SECRET'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌  متغيرات بيئة مفقودة: ${missing.join(', ')}`);
  console.error('    انسخ .env.example → .env وأكمل القيم\n');
  process.exit(1);
}

module.exports = {
  port:         parseInt(process.env.PORT    || '3000', 10),
  mongoUri:     process.env.MONGODB_URI      || 'mongodb://localhost:27017/xops',
  mongoPoolSize: parseInt(process.env.MONGO_POOL_SIZE || '30', 10),
  redisUrl:     process.env.REDIS_URL        || 'redis://localhost:6379',
  appSecret:    process.env.APP_SECRET,
  vaultKey:     process.env.VAULT_KEY,
  jwtExpires:   process.env.JWT_EXPIRES      || '24h',
  env:          process.env.NODE_ENV         || 'development',
  logLevel:     process.env.LOG_LEVEL        || 'info',
  ai: {
    apiKey:  process.env.ANTHROPIC_API_KEY,
    model:   process.env.AI_MODEL || 'claude-sonnet-4-20250514',
  },
  browser: {
    headless:    process.env.PLAYWRIGHT_HEADLESS !== 'false',
    limit:       parseInt(process.env.BROWSER_LIMIT || '5', 10),
    sessionDir:  process.env.SESSION_DIR || './data/sessions',
  },
  workers: {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || process.env.BROWSER_LIMIT || '5', 10),
  },
  bulkImport: {
    dbConcurrency:     parseInt(process.env.IMPORT_DB_CONCURRENCY || '20', 10),
    healthConcurrency: parseInt(process.env.IMPORT_HEALTH_CONCURRENCY || process.env.BROWSER_LIMIT || '5', 10),
  },
  caps: {
    follow:  parseInt(process.env.CAP_FOLLOW || '50',  10),
    like:    parseInt(process.env.CAP_LIKE   || '100', 10),
    reply:   parseInt(process.env.CAP_REPLY  || '30',  10),
    post:    parseInt(process.env.CAP_POST   || '10',  10),
  },
  delay: {
    min: parseInt(process.env.DELAY_MIN_MS || '3000',  10),
    max: parseInt(process.env.DELAY_MAX_MS || '12000', 10),
  },
};
