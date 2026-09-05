'use strict';
require('express-async-errors');
const express     = require('express');
const http        = require('http');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const { Server }  = require('socket.io');
const path        = require('path');
const cron        = require('node-cron');
const mongoose    = require('mongoose');

const cfg        = require('./src/config');
const LicenseSvc = require('./src/services/license.service');
const logger     = require('./src/utils/logger');
const { connectMongo } = require('./src/db/mongo');
const { connectRedis, getRedis, disconnectRedis } = require('./src/db/redis');
const { errorHandler, authMiddleware } = require('./src/middleware/index');

const authRoutes    = require('./src/routes/auth.routes');
const accRoutes     = require('./src/routes/account.routes');
const { actionRouter, contentRouter, dashRouter, proxyRouter, opsRouter, engRouter } = require('./src/routes/index');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
global.io    = io;
let bullMqReady = false;
let shuttingDown = false;

// ── Core middleware ──────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: m => logger.http(m.trim()) } }));
app.use(rateLimit({ windowMs: 15 * 60_000, max: 500, standardHeaders: true, legacyHeaders: false }));

// ── Static dashboard ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Health (no auth) ─────────────────────────────────────────
app.get('/health', (req, res) => {
  const Browser = require('./src/services/browser.service');
  const redis = getRedis();
  const mongoConnected = mongoose.connection.readyState === 1;
  const redisConnected = redis?.status === 'ready';
  const healthy = mongoConnected && redisConnected && bullMqReady;
  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    status: healthy ? 'healthy' : 'degraded',
    uptime: Math.round(process.uptime()),
    mongo: { connected: mongoConnected },
    redis: { connected: redisConnected },
    workers: { ready: bullMqReady },
    browser: Browser.stats(),
  });
});

// ── API ───────────────────────────────────────────────────────
const API = '/api/v1';
app.use(`${API}/auth`,      authRoutes);
app.use(`${API}/accounts`,  accRoutes);
app.use(`${API}/actions`,    actionRouter);
app.use(`${API}/content`,    contentRouter);
app.use(`${API}/proxies`,    proxyRouter);
app.use(`${API}/dashboard`,  dashRouter);
app.use(`${API}/ops`,        opsRouter);
app.use(`${API}/engagement`, engRouter);

// ── Route for home.html ───────────────────────────────────────
app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// ── React Console ─────────────────────────────────────────────
// أي مسار يبدأ بـ /console يُعاد توجيهه لـ index.html الخاصة بالـ React build
app.use('/console', express.static(path.join(__dirname, 'public', 'console')));
app.get('/console/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'console', 'index.html'));
});

// ── SPA fallback ─────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Route not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(errorHandler);


// ── Socket.IO ─────────────────────────────────────────────────
io.on('connection', socket => {
  logger.info(`[WS] Connected: ${socket.id}`);
  socket.on('disconnect', () => logger.info(`[WS] Disconnected: ${socket.id}`));
});

// ── License: تحقق عند البدء وكل 6 ساعات ────────────────────
LicenseSvc.verifyLicense().then(lic => {
  if (!lic.valid && !lic.standalone) {
    logger.warn(`[License] ⚠️ ${lic.error || 'ترخيص غير صالح'}`);
  }
});
cron.schedule('0 */6 * * *', () => LicenseSvc.verifyLicense());

// ── API: معلومات الترخيص ──────────────────────────────────────
app.get('/api/v1/license', (req, res) => {
  const lic = LicenseSvc.getLicense();
  res.json({
    valid:       lic.valid,
    standalone:  lic.standalone,
    subscriber:  lic.subscriber,
    daysLeft:    lic.daysLeft,
    endDate:     lic.endDate,
    permissions: lic.permissions,
    error:       lic.error,
  });
});

// ── CRON: reset daily counters (midnight) ────────────────────
cron.schedule('0 0 * * *', async () => {
  const Account = require('./src/models/Account');
  const today   = new Date().toISOString().slice(0, 10);
  const r = await Account.updateMany(
    { 'todayCounters.date': { $ne: today } },
    { $set: { todayCounters: { date:today, follows:0, likes:0, replies:0, posts:0, reposts:0 } } }
  );
  logger.info(`[Cron] Daily counters reset (${r.modifiedCount} accounts)`);
});

// ── Legacy scheduler fallback ─────────────────────────────────
// This direct publisher is only a fallback. `bullMqReady` is based on the
// actual Redis/worker connection, not merely on REDIS_* being present in .env.
cron.schedule('*/2 * * * *', async () => {
  if (bullMqReady) return;
  const { Content, Schedule } = require('./src/models/index');
  const Account   = require('./src/models/Account');
  const ActionSvc = require('./src/services/action.service');

  const dueIds = await Schedule.find({ status:'pending', scheduledAt: { $lte: new Date() } })
    .select('_id').limit(10).lean();

  for (const row of dueIds) {
    const sched = await Schedule.findOneAndUpdate(
      { _id:row._id, status:'pending' },
      { $set:{ status:'running' } },
      { new:true },
    ).populate('account').populate('content');
    if (!sched) continue;
    if (!sched.account?.isOperational || !sched.content?.text) {
      sched.status = 'failed'; await sched.save(); continue;
    }
    try {
      const result = await ActionSvc.tweet(sched.account, { text: sched.content.text });
      if (!result?.tweetId || !result?.tweetUrl) throw new Error('TweetNotConfirmed: X did not return a tweet id');
      sched.content.status = 'منشور';
      sched.content.publishedAt = new Date();
      sched.content.tweetId = result.tweetId;
      sched.content.tweetUrl = result.tweetUrl;
      await sched.content.save();
      sched.status = 'done';
      await sched.save();
      logger.info(`[Cron] Scheduled post published: @${sched.account.username}`);
    } catch (e) {
      sched.status = 'failed';
      await sched.save();
      logger.error(`[Cron] Scheduled post failed @${sched.account.username}: ${e.message}`);
    }
  }
});

// ── CRON: مراقبة المخاطر (كل 30 دقيقة) ──────────────────────
cron.schedule('*/30 * * * *', async () => {
  const Account    = require('./src/models/Account');
  const { RiskEvent } = require('./src/models/index');
  const pendingRisks = [];
  let openRiskKeys = new Set();

  const createRisk = async (account, type, level, description, details = {}) => {
    const key = `${account._id}:${type}`;
    if (openRiskKeys.has(key)) return;
    openRiskKeys.add(key);
    pendingRisks.push({ account:account._id, username:account.username, type, level, description, details });
  };

  try {
    const accounts = await Account.find({ isActive: true });
    const existingRisks = await RiskEvent.find({
      account:{ $in:accounts.map(account => account._id) },
      resolved:false,
    }).select('account type').lean();
    openRiskKeys = new Set(existingRisks.map(risk => `${risk.account}:${risk.type}`));
    const activeAccountIds = [];

    for (const account of accounts) {
      // 1. حساب موقوف أو مغلق
      if (['suspended','locked','dead'].includes(account.status)) {
        await createRisk(account, 'account_suspended', 'critical',
          `الحساب @${account.username} موقوف أو محظور`, { status: account.status });
      }

      // 2. حساب يحتاج مصادقة
      if (account.status === 'auth_required') {
        await createRisk(account, 'auth_required', 'high',
          `الحساب @${account.username} يحتاج إعادة مصادقة`);
      }

      // 3. تجاوز الحد اليومي للنشر
      const postCap  = account.dailyCaps?.post  || 10;
      const postDone = account.todayCounters?.posts || 0;
      if (postDone >= postCap * 0.9) {
        await createRisk(account, 'daily_cap_warning', 'medium',
          `@${account.username} وصل لـ ${postDone}/${postCap} منشور اليوم`,
          { done: postDone, cap: postCap });
      }

      // 4. حساب غير نشط أكثر من 3 أيام
      if (account.lastActiveAt) {
        const daysSince = (Date.now() - new Date(account.lastActiveAt)) / 86_400_000;
        if (daysSince > 3 && account.status === 'active') {
          await createRisk(account, 'inactive_account', 'low',
            `@${account.username} لم ينشط منذ ${Math.floor(daysSince)} أيام`,
            { daysSince: Math.floor(daysSince) });
        }
      }

      // 5. حل المخاطر التي انتهت (الحساب عاد نشطاً)
      if (account.status === 'active') {
        activeAccountIds.push(account._id);
      }
    }

    await Promise.all([
      pendingRisks.length
        ? RiskEvent.insertMany(pendingRisks.map(({ username, ...risk }) => risk), { ordered:false })
        : Promise.resolve(),
      activeAccountIds.length
        ? RiskEvent.updateMany(
            { account:{ $in:activeAccountIds }, type:{ $in:['auth_required','account_suspended'] }, resolved:false },
            { $set:{ resolved:true, resolvedAt:new Date(), resolution:'تلقائي — الحساب عاد نشطاً' } },
          )
        : Promise.resolve(),
    ]);
    for (const risk of pendingRisks) {
      logger.info(`[Risk] ${risk.level} — @${risk.username}: ${risk.description}`);
      if (global.io) global.io.emit('risk:new', {
        username:risk.username, type:risk.type, level:risk.level, description:risk.description,
      });
    }
  } catch (e) {
    logger.error(`[Cron] Risk monitor error: ${e.message}`);
  }
});

// ── CRON: cleanup old resolved risks (weekly) ────────────────
cron.schedule('0 4 * * 0', async () => {
  const { RiskEvent } = require('./src/models/index');
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const r = await RiskEvent.deleteMany({ resolved:true, resolvedAt:{ $lt: cutoff } });
  logger.info(`[Cron] Cleaned ${r.deletedCount} old risk events`);
});

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Shutdown] ${sig} received — shutting down cleanly...`);

  require('./src/scheduler/post-scheduler').stopScheduler();
  await require('./src/queues/workers').stopWorkers().catch(e => logger.warn(`[Shutdown] Workers: ${e.message}`));
  await require('./src/queues/queues').closeAllQueues().catch(e => logger.warn(`[Shutdown] Queues: ${e.message}`));
  await require('./src/queues/connection').closeRedis().catch(e => logger.warn(`[Shutdown] BullMQ Redis: ${e.message}`));

  await new Promise(resolve => {
    if (!server.listening) return resolve();
    const timeout = setTimeout(resolve, 5000);
    server.close(() => { clearTimeout(timeout); resolve(); });
  });
  await require('./src/services/browser.service').shutdown().catch(e => logger.warn(`[Shutdown] Browser: ${e.message}`));
  await disconnectRedis().catch(e => logger.warn(`[Shutdown] Redis: ${e.message}`));
  await mongoose.disconnect().catch(e => logger.warn(`[Shutdown] MongoDB: ${e.message}`));
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  e => logger.error('[UncaughtException]', e));
process.on('unhandledRejection', e => logger.error('[UnhandledRejection]', e));

// ── Bootstrap ─────────────────────────────────────────────────
async function start() {
  logger.info('');
  logger.info('==========================================');
  logger.info('         XOps Platform  v3.0             ');
  logger.info('==========================================');

  await connectMongo();
  const redisClient = await connectRedis().catch(() => null); // Redis is optional

  // ── BullMQ Workers ───────────────────────────────────────────
if (redisClient) {
  const { startWorkers } = require('./src/queues/workers');

  try {
    await startWorkers(global.io);
    bullMqReady = true;
    const { getQueue, QUEUE_NAMES } = require('./src/queues/queues');
    const { resetPreviousProfileJobs } = require('./src/services/profile-queue.service');
    await resetPreviousProfileJobs(getQueue(QUEUE_NAMES.PROFILE_UPDATE), { reason:'server startup' })
      .catch(error => logger.warn(`[ProfileQueue] Startup cleanup failed: ${error.message}`));
  } catch (err) {
    logger.warn(`[Workers] Failed to start; legacy scheduler fallback is active: ${err.message}`);
    await require('./src/queues/workers').stopWorkers().catch(() => {});
  }

  // ── Scheduler: ينشر التغريدات المجدولة عند وقتها ──
  if (bullMqReady) {
    const { startScheduler } = require('./src/scheduler/post-scheduler');
    startScheduler();
  }

} else {
  logger.warn('[Workers] Redis unavailable; queued operations are disabled and will return HTTP 503');
}

server.listen(cfg.port, () => {
    logger.info(`[Server] Running at http://localhost:${cfg.port}`);
    logger.info(`[Server] Dashboard: http://localhost:${cfg.port}`);
    logger.info(`[Server] Health:    http://localhost:${cfg.port}/health`);
    logger.info('');
    // logger.info('[Setup] First run? Register admin:');
    // logger.info(`  curl -X POST http://localhost:${cfg.port}/api/v1/auth/register \\`);
    // logger.info(`    -H "Content-Type: application/json" \\`);
    // logger.info(`    -d '{"email":"admin@example.com","password":"YourPass123!"}'`);
    logger.info('');
  });
}

start().catch(e => { logger.error('[Startup] Failed:', e); process.exit(1); });
