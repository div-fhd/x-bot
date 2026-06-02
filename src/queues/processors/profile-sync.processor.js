'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const ActionSvc  = require('../../services/action.service');
const Browser    = require('../../services/browser.service');
const { jobEvents } = require('../events/job.events');
const logger     = require('../../utils/logger');

module.exports = wrapProcessor(async function profileSyncProcessor(job, { isCancelled }) {
  const { accountId, meta } = job.data;
  const account = await Account.findById(accountId);
  if (!account?.isActive) throw new Error(`SKIP: @${account?.username} — inactive`);
  await job.updateProgress(10);
  try {
    await ActionSvc.syncProfile(account);
    await job.updateProgress(100);
    jobEvents.syncProg({ username: account.username, done: meta.index + 1, total: meta.total, profile: account.profile });
    return { success: true };
  } catch(e) {
    logger.warn(`[ProfileSync] @${account.username}: ${e.message}`);
    jobEvents.syncProg({ username: account.username, done: meta.index + 1, total: meta.total, error: e.message });
    throw e;
  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
}
);
