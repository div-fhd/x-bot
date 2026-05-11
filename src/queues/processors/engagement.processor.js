'use strict';
const { wrapProcessor } = require('./base.processor');
const Account           = require('../../models/Account');
const ActionSvc         = require('../../services/action.service');
const Browser           = require('../../services/browser.service');
const { EngageCampaign, log } = require('../../models/index');
const { jobEvents }     = require('../events/job.events');
const logger            = require('../../utils/logger');

module.exports = wrapProcessor(async function engagementProcessor(job, { isCancelled }) {
  const { accountId, campaignId, action, tweetId, tweetUrl, replyText, meta } = job.data;

  const account = await Account.findById(accountId);
  if (!account) throw new Error(`SKIP: account ${accountId} not found`);
  if (!account.isActive)
    throw new Error(`SKIP: @${account.username} — inactive`);
  if (['suspended','locked','dead','auth_required'].includes(account.status))
    throw new Error(`SKIP: @${account.username} — ${account.status}`);

  const actionMap = { like: 'like', retweet: 'repost', reply: 'reply' };
  const cap = actionMap[action];
  if (cap && !account.canDo(cap))
    throw new Error(`SKIP: @${account.username} — daily ${cap} cap reached`);

  await job.updateProgress(10);

  try {
    switch (action) {
      case 'like':
        await ActionSvc.like(account, tweetId);
        await account.bump('like').catch(() => {});
        break;

      case 'retweet':
        await ActionSvc.retweet(account, tweetId);
        await account.bump('repost').catch(() => {});
        break;

      case 'reply':
        if (!replyText) throw new Error(`SKIP: @${account.username} — no reply text`);
        await ActionSvc.reply(account, tweetId, replyText);
        await account.bump('reply').catch(() => {});
        break;

      case 'follow_author':
        const handle = meta?.authorHandle;
        if (!handle) throw new Error(`SKIP: @${account.username} — no author handle`);
        await ActionSvc.follow(account, handle);
        await account.bump('follow').catch(() => {});
        break;

      default:
        throw new Error(`SKIP: unknown action: ${action}`);
    }

    await log(accountId, 'engagement', `engagement_${action}`, 'success', { campaignId, tweetId });
    await job.updateProgress(100);

    jobEvents.progress({
      jobId:    meta.parentJobId,
      type:     'engagement',
      username: account.username,
      action,
      done:     meta.index + 1,
      total:    meta.total,
      success:  true,
    });

    return { success: true, username: account.username, action };

  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
});