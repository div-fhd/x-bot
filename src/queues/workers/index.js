'use strict';
const { Worker }       = require('bullmq');
const { createConnection } = require('../connection');
const { QUEUE_NAMES }  = require('../queues');
const { setIO, attachQueueEvents } = require('../events/job.events');
const logger           = require('../../utils/logger');
const cfg              = require('../../config');
const WORKER_CONCURRENCY = Math.max(1, cfg.workers.concurrency);

const PROCESSOR_MAP = {
  [QUEUE_NAMES.FOLLOW]:         require('../processors/follow.processor'),
  [QUEUE_NAMES.LIKE]:           require('../processors/like.processor'),
  [QUEUE_NAMES.RETWEET]:        require('../processors/retweet.processor'),
  [QUEUE_NAMES.TWEET_MULTI]:    require('../processors/tweet-multi.processor'),
  [QUEUE_NAMES.MUTUAL_FOLLOW]:  require('../processors/mutual-follow.processor'),
  [QUEUE_NAMES.REPORT_ACCOUNT]: require('../processors/report.processor'),
  [QUEUE_NAMES.REPORT_TWEET]:   require('../processors/report.processor'),
  [QUEUE_NAMES.PROFILE_UPDATE]: require('../processors/profile-update.processor'),
  [QUEUE_NAMES.PROFILE_SYNC]:   require('../processors/profile-sync.processor'),
  [QUEUE_NAMES.HEALTH_CHECK]:   require('../processors/health-check.processor'),
  [QUEUE_NAMES.ENGAGEMENT]:     require('../processors/engagement.processor'),
  [QUEUE_NAMES.SCHEDULED_POST]: require('../processors/scheduled-post.processor'),
};

const _workers    = [];
const _queueEvents = [];

async function startWorkers(io) {
  setIO(io);

  // Bridge registry events → Socket.IO
  const { registry } = require('../../ops/operations.registry');
  const { browserRegistry } = require('../../ops/browser.registry');
  const { getQueueHealth }  = require('../../ops/queue.monitor');

  ['op:created','op:progress','op:completed','op:cancelled','op:paused','op:resumed','op:retrying','op:cancelling']
    .forEach(ev => registry.on(ev, data => {
      io.emit(ev, data);
      if (ev === 'op:completed' && data.type === 'health-check') {
        io.emit('account:check:done', { total:data.total, success:data.success, failed:data.failed, skipped:data.skipped });
      }
    }));

  // Browser context pulse every 3s
  setInterval(() => io.emit('browsers:snapshot', browserRegistry.snapshot()), 3000).unref();

  // Queue health pulse every 10s
  setInterval(async () => {
    const h = await getQueueHealth().catch(() => null);
    if (h) io.emit('queues:health', h);
  }, 10_000).unref();

  for (const [queueName, processor] of Object.entries(PROCESSOR_MAP)) {
    const worker = new Worker(queueName, processor, {
      connection:      createConnection(),
      concurrency:     WORKER_CONCURRENCY,
      stalledInterval: 30_000,
      lockDuration:    180_000,
    });

    worker.on('completed', job  => logger.info(`[Worker] ✓ ${queueName} job ${job.id} done`));
    worker.on('failed', (job, err) => {
      const skip = err.message?.includes('SKIP:');
      logger[skip ? 'warn' : 'error'](`[Worker] ✗ ${queueName} job ${job?.id}: ${err.message}`);
    });
    worker.on('error', err => logger.error(`[Worker] ${queueName} error: ${err.message}`));

    _workers.push(worker);
    _queueEvents.push(attachQueueEvents(queueName));
  }

  // Only announce readiness after the workers have actually registered in
  // Redis. Otherwise producers can queue jobs that nobody is consuming.
  await Promise.all(_workers.map(worker => worker.waitUntilReady()));
  logger.info(`[Workers] Started ${_workers.length} workers (per-queue concurrency: ${WORKER_CONCURRENCY}, browser limit: ${cfg.browser.limit})`);
}

async function stopWorkers() {
  logger.info('[Workers] Graceful shutdown...');
  await Promise.allSettled(_workers.map(w => w.close()));
  await Promise.allSettled(_queueEvents.map(qe => qe.close()));
  logger.info('[Workers] All workers stopped');
}

module.exports = { startWorkers, stopWorkers };
