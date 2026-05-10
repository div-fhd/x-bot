'use strict';
const { getQueue, QUEUE_NAMES } = require('../queues/queues');

async function getQueueStats() {
  const results = {};
  for (const [key, name] of Object.entries(QUEUE_NAMES)) {
    try {
      const q      = getQueue(name);
      const counts = await q.getJobCounts('waiting','active','completed','failed','delayed','paused');
      results[key] = { name, ...counts, paused: await q.isPaused() };
    } catch { results[key] = { name, error: true, waiting:0, active:0, completed:0, failed:0, delayed:0 }; }
  }
  return results;
}

async function getQueueHealth() {
  const stats  = await getQueueStats();
  const issues = [];
  const limit  = parseInt(process.env.BROWSER_LIMIT || '5');
  for (const [key, q] of Object.entries(stats)) {
    if (q.error) continue;
    if (q.failed  > 20)    issues.push({ queue: key, type: 'high_failures',    count: q.failed });
    if (q.waiting > 200)   issues.push({ queue: key, type: 'queue_backlog',    count: q.waiting });
    if (q.active  > limit) issues.push({ queue: key, type: 'over_concurrency', count: q.active });
  }
  return { stats, issues, healthy: issues.length === 0 };
}

module.exports = { getQueueStats, getQueueHealth };
