// ── Force Kill All — يوقف كل العمليات النشطة فوراً ─────────
async function forceKillAll() {
  const { cancelTokens } = require('./operations.registry');
  const Browser = require('../services/browser.service');
  const { browserRegistry } = require('./browser.registry');

  // 1. أضف كل العمليات النشطة للـ cancel tokens
  const active = registry.getActive();
  for (const op of active) {
    cancelTokens.add(op.parentJobId);
    await registry.cancel(op.parentJobId).catch(() => {});
  }

  // 2. أغلق كل browser contexts مفتوحة
  const contexts = browserRegistry.getAll();
  await Promise.allSettled(
    contexts.map(c => Browser.closeContext(c.accountId, { force: true }).catch(() => {}))
  );

  return { killed: active.length, browsers: contexts.length };
}

'use strict';
const { registry }            = require('./operations.registry');
const { browserRegistry }     = require('./browser.registry');
const { getQueueStats, getQueueHealth } = require('./queue.monitor');

const JOB_STATES = new Set(['waiting', 'active', 'delayed', 'failed', 'prioritized']);

function resolveQueueKey(rawKey) {
  const { QUEUE_NAMES } = require('../queues/queues');
  const key = String(rawKey || '').toUpperCase();
  return QUEUE_NAMES[key] ? { key, name: QUEUE_NAMES[key] } : null;
}

module.exports = {
  async getActive(req, res)  { res.json({ ops: registry.getActive() }); },
  async getAll(req, res)     { res.json({ ops: registry.getAll() }); },
  async getOne(req, res)     {
    const op = registry.get(req.params.id);
    if (!op) return res.status(404).json({ error: 'Not found' });
    res.json(registry._snap(op));
  },
  async cancel(req, res) {
    const ok = await registry.cancel(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Cannot cancel' });
    if (global.io) global.io.emit('op:cancelled', { parentJobId: req.params.id });
    res.json({ cancelled: true });
  },
  async pause(req, res) {
    const ok = await registry.pause(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Cannot pause' });
    res.json({ paused: true });
  },
  async resume(req, res) {
    const ok = await registry.resume(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Cannot resume' });
    res.json({ resumed: true });
  },
  async retry(req, res) {
    const count = await registry.retryFailed(req.params.id);
    res.json({ retried: count });
  },
  async reprioritize(req, res) {
    const { priority = 1 } = req.body;
    const ok = await registry.reprioritize(req.params.id, priority);
    res.json({ reprioritized: ok });
  },
  async getBrowsers(req, res)    { res.json(browserRegistry.snapshot()); },
  async getQueues(req, res)      { res.json(await getQueueHealth()); },
  async getQueueStats(req, res)  { res.json(await getQueueStats()); },
  async listQueueJobs(req, res) {
    const { getQueue, QUEUE_NAMES } = require('../queues/queues');
    const requested = String(req.query.states || 'waiting,active,delayed,failed,prioritized')
      .split(',').map(value => value.trim()).filter(value => JOB_STATES.has(value));
    const states = requested.length ? requested : ['waiting', 'active', 'delayed', 'failed'];
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 100, 300));
    const selected = req.query.queue ? resolveQueueKey(req.query.queue) : null;
    if (req.query.queue && !selected) return res.status(404).json({ error: 'Queue not found' });
    const entries = selected ? [[selected.key, selected.name]] : Object.entries(QUEUE_NAMES);
    const perQueueLimit = selected ? limit : Math.max(10, Math.ceil(limit / entries.length));
    const rows = [];

    for (const [queueKey, queueName] of entries) {
      const jobs = await getQueue(queueName).getJobs(states, 0, perQueueLimit - 1, false).catch(() => []);
      const mapped = await Promise.all(jobs.map(async job => {
        const state = await job.getState().catch(() => 'unknown');
        return {
          id: String(job.id), queueKey, queueName, state, name: job.name,
          accountId: job.data?.accountId || null,
          username: job.data?.username || null,
          parentJobId: job.data?.meta?.parentJobId || null,
          index: job.data?.meta?.index,
          total: job.data?.meta?.total,
          progress: job.progress || 0,
          attemptsMade: job.attemptsMade || 0,
          maxAttempts: job.opts?.attempts || 1,
          createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
          processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
          runAt: job.delay && job.timestamp ? new Date(job.timestamp + job.delay).toISOString() : null,
          failedReason: job.failedReason ? String(job.failedReason).slice(0, 500) : null,
          protected: queueKey === 'SCHEDULED_POST',
        };
      }));
      rows.push(...mapped);
    }
    rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ jobs: rows.slice(0, limit), total: rows.length, states });
  },
  async cancelQueueJob(req, res) {
    const resolved = resolveQueueKey(req.params.queueKey);
    if (!resolved) return res.status(404).json({ error: 'Queue not found' });
    if (resolved.key === 'SCHEDULED_POST') {
      return res.status(409).json({ error: 'ألغِ المنشور من صفحة الجدولة حتى تتحدث قاعدة البيانات والطابور معًا.' });
    }
    const { getQueue } = require('../queues/queues');
    const job = await getQueue(resolved.name).getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const state = await job.getState();
    if (state === 'active') {
      const parentJobId = job.data?.meta?.parentJobId;
      if (!parentJobId) return res.status(409).json({ error: 'المهمة نشطة ولا ترتبط بعملية قابلة للإيقاف.' });
      const ok = await registry.cancel(parentJobId);
      if (!ok) return res.status(409).json({ error: 'تعذر إيقاف العملية الأم.' });
      return res.json({ cancelled: true, scope: 'operation', parentJobId });
    }
    if (!['waiting', 'delayed', 'prioritized'].includes(state)) {
      return res.status(409).json({ error: `لا يمكن إلغاء Job في حالة ${state}` });
    }
    await job.remove();
    const parentJobId = job.data?.meta?.parentJobId;
    if (parentJobId) {
      registry.jobDone(parentJobId, job.id, {
        username: job.data?.username || job.data?.accountId || String(job.id),
        success: false,
        skipped: true,
      });
    }
    res.json({ cancelled: true, scope: 'job', jobId: String(job.id) });
  },
  async retryQueueJob(req, res) {
    const resolved = resolveQueueKey(req.params.queueKey);
    if (!resolved) return res.status(404).json({ error: 'Queue not found' });
    const { getQueue } = require('../queues/queues');
    const job = await getQueue(resolved.name).getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (await job.getState() !== 'failed') return res.status(409).json({ error: 'يمكن إعادة محاولة المهام الفاشلة فقط.' });
    const parentJobId = job.data?.meta?.parentJobId;
    if (parentJobId) registry.jobRetried(parentJobId);
    try {
      await job.retry();
    } catch (error) {
      if (parentJobId) registry.jobDone(parentJobId, job.id, {
        username: job.data?.username || job.data?.accountId || String(job.id),
        success: false,
        error: error.message,
      });
      throw error;
    }
    res.json({ retried: true, jobId: String(job.id) });
  },
  async removeQueueJob(req, res) {
    const resolved = resolveQueueKey(req.params.queueKey);
    if (!resolved) return res.status(404).json({ error: 'Queue not found' });
    const { getQueue } = require('../queues/queues');
    const job = await getQueue(resolved.name).getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const state = await job.getState();
    if (!['failed', 'completed'].includes(state)) return res.status(409).json({ error: 'يمكن حذف المهام المنتهية أو الفاشلة فقط.' });
    await job.remove();
    res.json({ removed: true, jobId: String(job.id) });
  },
  async pauseQueue(req, res) {
    const { getQueue, QUEUE_NAMES } = require('../queues/queues');
    const name = QUEUE_NAMES[req.params.key];
    if (!name) return res.status(404).json({ error: 'Queue not found' });
    await getQueue(name).pause();
    res.json({ paused: true, queue: name });
  },
  async resumeQueue(req, res) {
    const { getQueue, QUEUE_NAMES } = require('../queues/queues');
    const name = QUEUE_NAMES[req.params.key];
    if (!name) return res.status(404).json({ error: 'Queue not found' });
    await getQueue(name).resume();
    res.json({ resumed: true, queue: name });
  },
  // POST /api/v1/ops/force-kill — أوقف كل شيء فوراً
  async forceKill(req, res) {
    const result = await forceKillAll();
    require('../utils/logger').warn(`[OpsCtrl] Force kill — ${result.killed} ops, ${result.browsers} browsers`);
    res.json({ ok: true, ...result });
  },

  async clearFailed(req, res) {
    const { getQueue, QUEUE_NAMES } = require('../queues/queues');
    const name = QUEUE_NAMES[req.params.key];
    if (!name) return res.status(404).json({ error: 'Queue not found' });
    await getQueue(name).clean(0, 1000, 'failed');
    res.json({ cleared: true });
  },
};
