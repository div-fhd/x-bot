'use strict';
const Account    = require('../../models/Account');
const ActionSvc  = require('../../services/action.service');
const Browser    = require('../../services/browser.service');
const { jobEvents } = require('../events/job.events');
const logger     = require('../../utils/logger');

module.exports = async function followProcessor(job) {
  const { accountId, targetHandle, meta } = job.data;
  const account = await Account.findById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  if (!account.isActive || ['suspended','banned'].includes(account.status)) {
    throw new Error(`SKIP: @${account.username} — ${account.status}`);
  }
  await job.updateProgress(10);
  try {
    await ActionSvc.follow(account, targetHandle);
    await job.updateProgress(100);
    jobEvents.progress({ jobId: meta.parentJobId, type: 'follow', username: account.username, done: meta.index + 1, total: meta.total, success: true });
    return { success: true, username: account.username };
  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
};
