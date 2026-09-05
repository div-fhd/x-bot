'use strict';
const { Worker }       = require('bullmq');
const { createConnection } = require('../connection');
const logger           = require('../../utils/logger');
const cfg              = require('../../config');

class BaseWorker {
  constructor(queueName, processor, opts = {}) {
    this.queueName = queueName;
    this.worker = new Worker(queueName, processor, {
      connection:      createConnection(),
      concurrency:     opts.concurrency || cfg.workers.concurrency,
      stalledInterval: 30_000,
      lockDuration:    180_000, // 3 min — covers any single action
    });
    this._attachEvents();
  }

  _attachEvents() {
    this.worker.on('completed', job =>
      logger.info(`[Worker:${this.queueName}] Job ${job.id} completed`)
    );
    this.worker.on('failed', (job, err) => {
      const skip = err.message?.includes('SKIP:');
      const msg  = skip ? `skipped: ${err.message.replace('SKIP:','').trim()}` : err.message;
      logger[skip ? 'warn' : 'error'](`[Worker:${this.queueName}] Job ${job?.id} failed: ${msg}`);
    });
    this.worker.on('stalled',  jobId => logger.warn(`[Worker:${this.queueName}] Job ${jobId} stalled`));
    this.worker.on('error',    err   => logger.error(`[Worker:${this.queueName}] Error: ${err.message}`));
  }

  async close() { await this.worker.close(); }
}

module.exports = BaseWorker;
