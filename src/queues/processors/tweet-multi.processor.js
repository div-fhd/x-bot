'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const { Content } = require('../../models/index');
const ActionSvc  = require('../../services/action.service');
const Browser    = require('../../services/browser.service');
const AISvc      = require('../../services/ai.service');
const { jobEvents } = require('../events/job.events');
const logger     = require('../../utils/logger');

module.exports = wrapProcessor(async function tweetMultiProcessor(job) {
  const {
    accountId, mode, text, topic, hashtags, manualTexts,
    mediaPaths, accountIndex,
    autoEngage, engageAccountIds, engageActions, engageActionGroups,
    engageReplyTexts, engageDelayMinMs, engageDelayMaxMs,
    meta,
  } = job.data;

  const account = await Account.findById(accountId);
  if (!account) throw new Error(`SKIP: account ${accountId} not found`);
  if (!account.isActive)
    throw new Error(`SKIP: @${account.username} — inactive`);
  if (['suspended','locked','dead','auth_required','checkpoint'].includes(account.status))
    throw new Error(`SKIP: @${account.username} — ${account.status}`);
  if (!account.canDo('post'))
    throw new Error(`SKIP: @${account.username} — daily post cap reached`);

  await job.updateProgress(10);

  try {
    // ── Resolve text ────────────────────────────────────────
    let finalText = text || topic;
    if (mode === 'ai') {
      try {
        const s = await AISvc.suggestTweets({ account, topic: topic || text, hashtags, count: 1 });
        finalText = s?.[0]?.text || topic || text;
        if (hashtags && !finalText.includes(hashtags.split(' ')[0])) {
          finalText = finalText.trim() + '\n\n' + hashtags;
        }
        if (finalText.length > 280) finalText = finalText.slice(0, 277) + '…';
      } catch { finalText = topic || text; }
    } else if (mode === 'manual') {
      const idx = accountIndex ?? meta.index;
      finalText = (manualTexts || [])[idx % Math.max(manualTexts?.length || 1, 1)] || text;
    }

    // ── Tweet ───────────────────────────────────────────────
    const r = await ActionSvc.tweet(account, {
      text: finalText,
      mediaLocalPaths: mediaPaths || [],
    });

    // ملاحظة: ActionSvc.tweet يتولّى bump('post') داخلياً — لا نضاعفه هنا
    const tweetUrl = r.tweetUrl ||
      (r.tweetId ? `https://x.com/${account.username}/status/${r.tweetId}` : null);

    await Content.create({
      account: account._id, text: finalText, status: 'منشور',
      publishedAt: new Date(), tweetId: r.tweetId, tweetUrl,
    });

    await job.updateProgress(80);
    jobEvents.tweetProg({
      username: account.username, done: meta.index + 1,
      total: meta.total, success: true, tweetId: r.tweetId,
    });

    // ── Auto-engage — مساعد مشترك (تخصيص بالفعل، جلسة واحدة لكل حساب) ──
    if (autoEngage && tweetUrl) {
      try {
        const { launchAutoEngage } = require('../../ops/auto-engage');
        await launchAutoEngage({
          tweetId: r.tweetId, tweetUrl,
          actionGroups: engageActionGroups, accountIds: engageAccountIds, actions: engageActions,
          replyTexts: engageReplyTexts, delayMinMs: engageDelayMinMs, delayMaxMs: engageDelayMaxMs,
          label: 'tweet-multi',
        });
      } catch(e) { logger.warn(`[TweetMulti] Auto-engage error: ${e.message}`); }
    }

    await job.updateProgress(100);
    return { success: true, tweetId: r.tweetId, tweetUrl };

  } catch(e) {
    if (!e.message.startsWith('SKIP:')) {
      jobEvents.tweetProg({ username:account.username, done:meta.index+1,
        total:meta.total, success:false, error:e.message });
    }
    throw e;
  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
});