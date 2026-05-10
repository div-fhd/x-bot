'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const ActionSvc  = require('../../services/action.service');
const Browser    = require('../../services/browser.service');
const { jobEvents } = require('../events/job.events');

module.exports = wrapProcessor(async function retweetProcessor(job) {
  const { accountId, tweetId, meta } = job.data;
  const account = await Account.findById(accountId);
  if (!account?.isActive) throw new Error(`SKIP: @${account?.username} — inactive`);
  await job.updateProgress(10);
  try {
    await ActionSvc.retweet(account, tweetId);
    await job.updateProgress(100);
    jobEvents.progress({ jobId: meta.parentJobId, type: 'retweet', username: account.username, done: meta.index + 1, total: meta.total, success: true });
    return { success: true };
  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
}
);
