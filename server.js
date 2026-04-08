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

const cfg        = require('./src/config');
const logger     = require('./src/utils/logger');
const { connectMongo } = require('./src/db/mongo');
const { connectRedis } = require('./src/db/redis');
const { errorHandler, authMiddleware } = require('./src/middleware/index');

const authRoutes    = require('./src/routes/auth.routes');
const accRoutes     = require('./src/routes/account.routes');
const { actionRouter, contentRouter, dashRouter } = require('./src/routes/index');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
global.io    = io;

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
  res.json({ ok: true, uptime: Math.round(process.uptime()), browser: Browser.stats() });
});

// ── API ───────────────────────────────────────────────────────
const API = '/api/v1';
app.use(`${API}/auth`,      authRoutes);
app.use(`${API}/accounts`,  accRoutes);
app.use(`${API}/actions`,   actionRouter);
app.use(`${API}/content`,   contentRouter);
app.use(`${API}/dashboard`, dashRouter);

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

// ── CRON: run due scheduled posts (every 2 min) ──────────────
cron.schedule('*/2 * * * *', async () => {
  const { Content, Schedule } = require('./src/models/index');
  const Account   = require('./src/models/Account');
  const ActionSvc = require('./src/services/action.service');

  const due = await Schedule.find({ status:'pending', scheduledAt: { $lte: new Date() } })
    .populate('account').populate('content').limit(10);

  for (const sched of due) {
    if (!sched.account?.isOperational || !sched.content?.text) {
      sched.status = 'failed'; await sched.save(); continue;
    }
    try {
      const result = await ActionSvc.tweet(sched.account, { text: sched.content.text });
      sched.content.status = 'منشور';
      sched.content.publishedAt = new Date();
      sched.content.tweetId = result.tweetId;
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

// ── CRON: cleanup old resolved risks (weekly) ────────────────
cron.schedule('0 4 * * 0', async () => {
  const { RiskEvent } = require('./src/models/index');
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const r = await RiskEvent.deleteMany({ resolved:true, resolvedAt:{ $lt: cutoff } });
  logger.info(`[Cron] Cleaned ${r.deletedCount} old risk events`);
});

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown(sig) {
  logger.info(`[Shutdown] ${sig} received — shutting down cleanly...`);
  server.close();
  await require('./src/services/browser.service').shutdown();
  await require('mongoose').disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  e => logger.error('[UncaughtException]', e));
process.on('unhandledRejection', e => logger.error('[UnhandledRejection]', e));

// ── Bootstrap ─────────────────────────────────────────────────
async function start() {
  logger.info('');
  logger.info('==========================================');
  logger.info('         XOps Platform  v3.0             ');
  logger.info('==========================================');

  await connectMongo();
  await connectRedis().catch(() => {}); // Redis is optional

  server.listen(cfg.port, () => {
    logger.info(`[Server] Running at http://localhost:${cfg.port}`);
    logger.info(`[Server] Dashboard: http://localhost:${cfg.port}`);
    logger.info(`[Server] Health:    http://localhost:${cfg.port}/health`);
    logger.info('');
    logger.info('[Setup] First run? Register admin:');
    logger.info(`  curl -X POST http://localhost:${cfg.port}/api/v1/auth/register \\`);
    logger.info(`    -H "Content-Type: application/json" \\`);
    logger.info(`    -d '{"email":"admin@example.com","password":"YourPass123!"}'`);
    logger.info('');
  });
}

start().catch(e => { logger.error('[Startup] Failed:', e); process.exit(1); });
