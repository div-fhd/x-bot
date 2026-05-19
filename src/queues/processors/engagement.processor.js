'use strict';
const { wrapProcessor } = require('./base.processor');
const Account        = require('../../models/Account');
const ActionSvc      = require('../../services/action.service');
const Browser        = require('../../services/browser.service');
const { log }        = require('../../models/index');
const { jobEvents }  = require('../events/job.events');
const logger         = require('../../utils/logger');

module.exports = wrapProcessor(async function engagementProcessor(job) {
  const { accountId, campaignId, actions, action, tweetId, tweetUrl, replyText, meta } = job.data;

  // Support both old (single action) and new (actions array)
  const actionList = actions || (action ? [action] : []);
  if (!actionList.length) throw new Error('SKIP: no actions specified');

  const account = await Account.findById(accountId);
  if (!account) throw new Error(`SKIP: account ${accountId} not found`);
  if (!account.isActive)
    throw new Error(`SKIP: @${account.username} — inactive`);
  if (['suspended','locked','dead','auth_required'].includes(account.status))
    throw new Error(`SKIP: @${account.username} — ${account.status}`);

  await job.updateProgress(5);

  try {
    const results = [];

    for (let i = 0; i < actionList.length; i++) {
      const act = actionList[i];

      // canDo check per action
      const capMap = { like:'like', retweet:'repost', reply:'reply', follow_author:'follow' };
      const cap = capMap[act];
      if (cap && !account.canDo(cap)) {
        logger.warn(`[Engagement] @${account.username} — ${act} cap reached, skipping`);
        results.push({ action: act, skipped: true });
        continue;
      }

      try {
        switch (act) {
          case 'like':
            await ActionSvc.like(account, tweetId);
            await account.bump('like').catch(() => {});
            break;

          case 'retweet':
            await ActionSvc.retweet(account, tweetId);
            await account.bump('repost').catch(() => {});
            break;

          case 'reply':
            if (!replyText) { logger.warn(`[Engagement] @${account.username} — no reply text`); break; }
            await ActionSvc.reply(account, tweetId, replyText);
            await account.bump('reply').catch(() => {});
            break;

          case 'follow_author': {
            const handle = meta?.authorHandle;
            if (!handle) { logger.warn(`[Engagement] @${account.username} — no authorHandle`); break; }
            await ActionSvc.follow(account, handle);
            await account.bump('follow').catch(() => {});
            break;
          }
        }
        results.push({ action: act, success: true });
        logger.info(`[Engagement] @${account.username} — ${act} ✓`);
      } catch(e) {
        logger.warn(`[Engagement] @${account.username} — ${act} failed: ${e.message}`);
        results.push({ action: act, success: false, error: e.message });
      }

      // Small delay between actions within same session
      if (i < actionList.length - 1) {
        await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
      }

      await job.updateProgress(Math.round(((i + 1) / actionList.length) * 90));
    }

    await job.updateProgress(100);

    jobEvents.progress({
      jobId:    meta.parentJobId,
      type:     'engagement',
      username: account.username,
      done:     meta.index + 1,
      total:    meta.total,
      success:  results.some(r => r.success),
      results,
    });

    return { success: true, username: account.username, results };

  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
});