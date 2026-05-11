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
    contexts.map(c => Browser.closeContext(c.accountId).catch(() => {}))
  );

  return { killed: active.length, browsers: contexts.length };
}

'use strict';
const { registry }            = require('./operations.registry');
const { browserRegistry }     = require('./browser.registry');
const { getQueueStats, getQueueHealth } = require('./queue.monitor');

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
