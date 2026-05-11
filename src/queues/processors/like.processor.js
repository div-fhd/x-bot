'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const ActionSvc  = require('../../services/action.service');
const Browser    = require('../../services/browser.service');
const { jobEvents } = require('../events/job.events');

module.exports = wrapProcessor(async function likeProcessor(job, { isCancelled }) {
  const { accountId, tweetId, meta } = job.data;
  const account = await Account.findById(accountId);
    if (!account.isActive)
    throw new Error(`SKIP: @${account.username} — inactive`);
  if (['suspended','locked','dead','auth_required'].includes(account.status))
    throw new Error(`SKIP: @${account.username} — ${account.status}`);
  if (!account.canDo('like'))
    throw new Error(`SKIP: @{account.username} — daily like cap reached`);
  await job.updateProgress(10);
  try {
    await ActionSvc.like(account, tweetId);
    await account.bump('like').catch(() => {});
    await job.updateProgress(100);
    jobEvents.progress({ jobId: meta.parentJobId, type: 'like', username: account.username, done: meta.index + 1, total: meta.total, success: true });
    return { success: true };
  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
}
);