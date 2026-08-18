'use strict';
const { registry, cancelTokens } = require('../ops/operations.registry');
const Browser = require('./browser.service');
const logger = require('../utils/logger');

async function resetPreviousProfileJobs(queue, { reason = 'new profile update' } = {}) {
  let cancelledOperations = 0;
  let removedJobs = 0;
  let stoppedActiveJobs = 0;

  await queue.pause();
  try {
    const previousOperations = registry.getActive().filter(op => op.type === 'profile-update');
    for (const operation of previousOperations) {
      if (await registry.cancel(operation.parentJobId).catch(() => false)) cancelledOperations++;
    }

    const activeJobs = await queue.getJobs(['active'], 0, -1, true);
    for (const job of activeJobs) {
      const parentJobId = job.data?.meta?.parentJobId;
      if (parentJobId) cancelTokens.add(parentJobId);
      try { job.discard(); } catch {}
      if (job.data?.accountId) {
        await Browser.closeContext(job.data.accountId, { force:true }).catch(() => {});
      }
      stoppedActiveJobs++;
    }

    const queuedJobs = await queue.getJobs(['waiting', 'delayed', 'prioritized'], 0, -1, true);
    for (const job of queuedJobs) {
      if (await job.remove().then(() => true).catch(() => false)) removedJobs++;
    }
    await queue.drain(true);
    await queue.clean(0, 10_000, 'failed');
    await queue.clean(0, 10_000, 'completed');
  } finally {
    await queue.resume().catch(() => {});
  }

  logger.info(`[ProfileQueue] Cleared previous jobs (${reason}): operations=${cancelledOperations}, queued=${removedJobs}, active=${stoppedActiveJobs}`);
  return { cancelledOperations, removedJobs, stoppedActiveJobs };
}

module.exports = { resetPreviousProfileJobs };
