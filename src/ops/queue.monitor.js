'use strict';
const { getQueue, QUEUE_NAMES } = require('../queues/queues');

async function getQueueStats() {
  const entries = await Promise.all(Object.entries(QUEUE_NAMES).map(async ([key, name]) => {
    try {
      const q      = getQueue(name);
      const [counts, paused] = await Promise.all([
        q.getJobCounts('waiting','active','completed','failed','delayed','paused'),
        q.isPaused(),
      ]);
      return [key, { name, ...counts, paused }];
    } catch (error) {
      return [key, { name, error:true, errorMessage:error.message, waiting:0, active:0, completed:0, failed:0, delayed:0 }];
    }
  }));
  return Object.fromEntries(entries);
}

async function getQueueHealth() {
  const stats  = await getQueueStats();
  const issues = [];
  const workerLimit = parseInt(process.env.WORKER_CONCURRENCY || process.env.BROWSER_LIMIT || '5');
  const backlogWarn = parseInt(process.env.QUEUE_BACKLOG_WARN || '1000');
  const failuresWarn = parseInt(process.env.QUEUE_FAILURES_WARN || '50');
  for (const [key, q] of Object.entries(stats)) {
    if (q.error)            { issues.push({ queue:key, type:'queue_unavailable', count:0 }); continue; }
    if (q.failed  > failuresWarn) issues.push({ queue:key, type:'high_failures', count:q.failed });
    if (q.waiting > backlogWarn)  issues.push({ queue:key, type:'queue_backlog', count:q.waiting });
    if (q.active  > workerLimit)  issues.push({ queue:key, type:'over_concurrency', count:q.active });
  }
  return { stats, issues, healthy: issues.length === 0 };
}

module.exports = { getQueueStats, getQueueHealth };
