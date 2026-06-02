'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const AuthSvc    = require('../../services/auth.service');
const { jobEvents } = require('../events/job.events');
const logger     = require('../../utils/logger');

module.exports = wrapProcessor(async function healthCheckProcessor(job, { isCancelled }) {
  const { accountId, meta } = job.data;
  const account = await Account.findById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  await job.updateProgress(10);
  try {
    await AuthSvc.checkHealth(account);
    await job.updateProgress(100);
    jobEvents.checkProg({ username: account.username, done: meta.index + 1, total: meta.total, status: account.status });
    if (meta.index + 1 === meta.total) {
      jobEvents.checkDone({ total: meta.total });
    }
    return { success: true, status: account.status };
  } catch(e) {
    logger.warn(`[HealthCheck] @${account.username}: ${e.message}`);
    jobEvents.checkProg({ username: account.username, done: meta.index + 1, total: meta.total, status: 'error' });
    throw e;
  }
}
);
