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

    // ── Auto-engage — تخصيص بالفعل (مثل الحملات): كل حساب يسوّي أفعاله في جلسة واحدة ──
    const eGroups = (engageActionGroups && typeof engageActionGroups === 'object') ? engageActionGroups : {};
    const eHasGroups = Object.values(eGroups).some(a => Array.isArray(a) && a.length);
    if (autoEngage && tweetUrl && (eHasGroups || (engageAccountIds?.length && engageActions?.length))) {
      try {
        const { getQueue, QUEUE_NAMES } = require('../queues');
        const { registry } = require('../../ops/operations.registry');

        // ابنِ قائمة العمل: [{ account, actions }]
        let workList = [];
        if (eHasGroups) {
          const byAccount = new Map(); // accountId → Set(actions)
          for (const [action, ids] of Object.entries(eGroups)) {
            if (!Array.isArray(ids)) continue;
            for (const id of ids) { const k = String(id); if (!byAccount.has(k)) byAccount.set(k, new Set()); byAccount.get(k).add(action); }
          }
          const accs = await Account.find({ _id: { $in: [...byAccount.keys()] }, isActive: true, status: 'active' });
          workList = accs.map(a => ({ account: a, actions: [...byAccount.get(String(a._id))] }));
        } else {
          const accs = await Account.find({ _id: { $in: engageAccountIds }, isActive: true, status: 'active' });
          workList = accs.map(a => ({ account: a, actions: engageActions }));
        }

        if (workList.length) {
          const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
          const ordered = shuffle(workList);
          const queue   = getQueue(QUEUE_NAMES.ENGAGEMENT);
          const parentJobId = `eng-auto-${r.tweetId}-${Date.now()}`;
          const minD = engageDelayMinMs || 8000;
          const maxD = engageDelayMaxMs || 25000;
          const jobs = ordered.map(({ account, actions }, i) => ({
            name: QUEUE_NAMES.ENGAGEMENT,
            data: {
              accountId: account._id.toString(),
              actions,
              tweetId:   r.tweetId,
              tweetUrl,
              replyText: (actions.includes('reply') && engageReplyTexts?.length) ? engageReplyTexts[i % engageReplyTexts.length] : null,
              meta: { parentJobId, index: i, total: ordered.length },
            },
            opts: { delay: Math.round(i*(minD+Math.random()*(maxD-minD))), attempts:2,
              jobId: `eng-auto-${r.tweetId}-${account._id}-${Date.now()}` },
          }));
          await queue.addBulk(jobs);
          registry.create({ parentJobId, type:'engagement', total:jobs.length,
            accountUsernames: ordered.map(w => w.account.username),
            meta: { auto:true, tweetId:r.tweetId, mode: eHasGroups ? 'per-action' : 'pool' } });
          registry.registerJobs(parentJobId, jobs.map(j=>j.opts.jobId));
          logger.info(`[TweetMulti] Auto-engage: ${jobs.length} jobs for tweet ${r.tweetId} (${eHasGroups?'per-action':'pool'})`);
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