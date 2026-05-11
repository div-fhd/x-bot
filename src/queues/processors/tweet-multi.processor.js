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
    autoEngage, engageAccountIds, engageActions,
    engageReplyTexts, engageDelayMinMs, engageDelayMaxMs,
    meta,
  } = job.data;

  const account = await Account.findById(accountId);
  if (!account) throw new Error(`SKIP: account ${accountId} not found`);
  if (!account.isActive)
    throw new Error(`SKIP: @${account.username} — inactive`);
  if (['suspended','locked','dead','auth_required'].includes(account.status))
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

    await account.bump('post').catch(() => {});
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

    // ── Auto-engage ─────────────────────────────────────────
    if (autoEngage && tweetUrl && engageAccountIds?.length && engageActions?.length) {
      try {
        const { getQueue, QUEUE_NAMES } = require('../queues');
        const { registry }              = require('../../ops/operations.registry');
        const engAccounts = await Account.find({
          _id: { $in: engageAccountIds }, isActive: true, status: 'active',
        });
        if (engAccounts.length) {
          const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
          const queue   = getQueue(QUEUE_NAMES.ENGAGEMENT);
          const parentJobId = `eng-auto-${r.tweetId}-${Date.now()}`;
          const jobs = [];
          for (const action of engageActions) {
            const ordered = shuffle(engAccounts);
            for (let i = 0; i < ordered.length; i++) {
              const acc = ordered[i];
              const actionOffset = {like:0,retweet:5000,reply:10000,follow_author:15000}[action]||0;
              const minD = engageDelayMinMs || 8000;
              const maxD = engageDelayMaxMs || 25000;
              const delay = Math.round(i*(minD+Math.random()*(maxD-minD))+actionOffset);
              const replyText = action==='reply'&&engageReplyTexts?.length
                ? engageReplyTexts[i%engageReplyTexts.length] : null;
              jobs.push({
                name: QUEUE_NAMES.ENGAGEMENT,
                data: { accountId:acc._id.toString(), action, tweetId:r.tweetId, tweetUrl, replyText,
                  meta:{parentJobId,index:jobs.length,total:engageActions.length*ordered.length} },
                opts: { delay, attempts:2, jobId:`eng-auto-${r.tweetId}-${action}-${acc._id}-${Date.now()}` },
              });
            }
          }
          jobs.forEach((j,i)=>{j.data.meta.index=i;j.data.meta.total=jobs.length;});
          await queue.addBulk(jobs);
          registry.create({ parentJobId, type:'engagement', total:jobs.length,
            accountUsernames:engAccounts.map(a=>a.username),
            meta:{auto:true,tweetId:r.tweetId,actions:engageActions} });
          registry.registerJobs(parentJobId, jobs.map(j=>j.opts.jobId));
          logger.info(`[TweetMulti] Auto-engage: ${jobs.length} jobs for tweet ${r.tweetId}`);
        }
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