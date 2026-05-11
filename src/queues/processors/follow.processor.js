'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const ActionSvc  = require('../../services/action.service');
const Browser    = require('../../services/browser.service');
const { jobEvents } = require('../events/job.events');
const logger     = require('../../utils/logger');

module.exports = wrapProcessor(async function followProcessor(job, { isCancelled }) {
  const { accountId, targetHandle, meta } = job.data;
  const account = await Account.findById(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  // status checks — all become SKIP (no retry)
  if (!account.isActive)
    throw new Error(`SKIP: @${account.username} — inactive`);
  if (['suspended','locked','dead','auth_required'].includes(account.status))
    throw new Error(`SKIP: @${account.username} — ${account.status}`);
  if (!account.canDo('follow'))
    throw new Error(`SKIP: @${account.username} — daily follow cap reached`);

  await job.updateProgress(10);
  try {
    await ActionSvc.follow(account, targetHandle);
    await account.bump('follow').catch(() => {});
    await job.updateProgress(100);
    jobEvents.progress({ jobId: meta.parentJobId, type: 'follow', username: account.username, done: meta.index + 1, total: meta.total, success: true });
    return { success: true, username: account.username };
  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
}
);