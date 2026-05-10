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
  async clearFailed(req, res) {
    const { getQueue, QUEUE_NAMES } = require('../queues/queues');
    const name = QUEUE_NAMES[req.params.key];
    if (!name) return res.status(404).json({ error: 'Queue not found' });
    await getQueue(name).clean(0, 1000, 'failed');
    res.json({ cleared: true });
  },
};
