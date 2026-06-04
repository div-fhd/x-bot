'use strict';
const { wrapProcessor } = require('./base.processor');
const Account        = require('../../models/Account');
const ActionSvc      = require('../../services/action.service');
const Browser        = require('../../services/browser.service');
const AISvc          = require('../../services/ai.service');
const { jobEvents }  = require('../events/job.events');
const logger         = require('../../utils/logger');

const CAP_MAP = {
  like:'like', retweet:'repost', reply:'reply',
  follow_author:'follow', quote_tweet:'post',
};

module.exports = wrapProcessor(async function engagementProcessor(job, { isCancelled }) {
  const {
    accountId, campaignId,
    actions, action,
    tweetId, tweetUrl,
    replyText, quoteMode, quoteTexts, quotePrompt,
    authorHandle, dwellSeconds,
    meta,
  } = job.data;

  const actionList = actions || (action ? [action] : []);
  if (!actionList.length) throw new Error('SKIP: no actions specified');

  const account = await Account.findById(accountId);
  if (!account) throw new Error(`SKIP: account ${accountId} not found`);
  if (!account.isActive)
    throw new Error(`SKIP: @${account.username} — inactive`);
  if (['suspended','locked','dead','auth_required','checkpoint'].includes(account.status))
    throw new Error(`SKIP: @${account.username} — ${account.status}`);

  await job.updateProgress(10);

  // Resolve quote text if needed
  logger.info(`[Engagement] quoteMode=${quoteMode} quoteTexts=${JSON.stringify(quoteTexts)} quotePrompt="${quotePrompt}"`);
  let resolvedQuoteText = null;
  if (actionList.includes('quote_tweet')) {
    if (quoteMode === 'ai') {
      try {
        const tweetContent = await ActionSvc.getTweetText(account, tweetId).catch(() => '');
        const suggestions  = await AISvc.suggestTweets({
          account,
          topic: quotePrompt || `اقتبس هذه التغريدة بأسلوب طبيعي: "${tweetContent.slice(0,100)}"`,
          count: 1,
        });
        resolvedQuoteText = suggestions?.[0]?.text || null;
      } catch(e) {
        logger.warn(`[Engagement] @${account.username} — AI quote failed: ${e.message}`);
      }
    }
    if (!resolvedQuoteText && quoteTexts?.length) {
      resolvedQuoteText = quoteTexts[(meta?.index ?? 0) % quoteTexts.length];
    }
  }

  // Filter out actions where canDo fails
  const execActions = actionList.filter(act => {
    const cap = CAP_MAP[act];
    if (cap && !account.canDo(cap)) {
      logger.warn(`[Engagement] @${account.username} — ${act} cap reached, skipping`);
      return false;
    }
    return true;
  });

  if (!execActions.length) throw new Error(`SKIP: @${account.username} — all actions capped`);

  await job.updateProgress(20);

  // Sort actions: dwell first (uses loaded page), quote/follow/profile_visit last (navigate away)
  const ORDER = ['tweet_dwell','like','retweet','bookmark','reply','share','quote_tweet','profile_visit','follow_author'];
  const sortedActions = [...execActions].sort((a,b) => {
    const ai = ORDER.indexOf(a); const bi = ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Single page session for all actions
  let results;
  try {
    results = await ActionSvc.engageTweet(account, tweetId, sortedActions, {
      tweetUrl:      tweetUrl,
      replyText:     replyText || null,
      quoteText:     resolvedQuoteText,
      authorHandle:  authorHandle || meta?.authorHandle,
      dwellSeconds:  dwellSeconds || 8,
      isCancelled,
    });
  } finally {
    // أغلق الـ context بعد ما engageTweet ينتهي — هنا وليس في base.processor
    await Browser.closeContext(account._id.toString()).catch(() => {});
  }

  await job.updateProgress(100);

  jobEvents.progress({
    jobId:    meta?.parentJobId,
    type:     'engagement',
    username: account.username,
    done:     (meta?.index ?? 0) + 1,
    total:    meta?.total ?? 1,
    success:  results?.results?.some(r => r.success),
    results:  results?.results,
  });

  return { success: true, username: account.username, ...results };

}, { managesOwnBrowser: true }); // engagement يدير الـ browser بنفسه عبر engageTweet