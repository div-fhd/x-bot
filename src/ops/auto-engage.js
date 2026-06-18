'use strict';
const Account  = require('../models/Account');
const { getQueue, QUEUE_NAMES } = require('../queues/queues');
const { registry } = require('./operations.registry');
const logger   = require('../utils/logger');

/**
 * يطلق حملة تفاعل تلقائية على تغريدة منشورة.
 * يدعم النمطين: actionGroups (تخصيص لكل فعل) أو accountIds+actions (مجموعة موحّدة).
 * يجمّع بالحساب → كل حساب يسوّي أفعاله في جلسة واحدة. مشترك بين النشر الجماعي والمجدول.
 */
async function launchAutoEngage({ tweetId, tweetUrl, actionGroups, accountIds, actions, replyTexts, delayMinMs, delayMaxMs, label = 'auto' }) {
  if (!tweetId || !tweetUrl) return null;

  const groups = (actionGroups && typeof actionGroups === 'object') ? actionGroups : {};
  const hasGroups = Object.values(groups).some(a => Array.isArray(a) && a.length);
  if (!hasGroups && !(accountIds?.length && actions?.length)) return null;

  // ابنِ قائمة العمل: [{ account, actions }]
  let workList = [];
  if (hasGroups) {
    const byAccount = new Map(); // accountId → Set(actions)
    for (const [action, ids] of Object.entries(groups)) {
      if (!Array.isArray(ids)) continue;
      for (const id of ids) { const k = String(id); if (!byAccount.has(k)) byAccount.set(k, new Set()); byAccount.get(k).add(action); }
    }
    const accs = await Account.find({ _id: { $in: [...byAccount.keys()] }, isActive: true, status: 'active' });
    workList = accs.map(a => ({ account: a, actions: [...byAccount.get(String(a._id))] }));
  } else {
    const accs = await Account.find({ _id: { $in: accountIds }, isActive: true, status: 'active' });
    workList = accs.map(a => ({ account: a, actions }));
  }
  if (!workList.length) return null;

  const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);
  const ordered = shuffle(workList);
  const queue   = getQueue(QUEUE_NAMES.ENGAGEMENT);
  const parentJobId = `eng-auto-${tweetId}-${Date.now()}`;
  const minD = delayMinMs || 8000, maxD = delayMaxMs || 25000;

  const jobs = ordered.map(({ account, actions }, i) => ({
    name: QUEUE_NAMES.ENGAGEMENT,
    data: {
      accountId: account._id.toString(),
      actions,
      tweetId, tweetUrl,
      replyText: (actions.includes('reply') && replyTexts?.length) ? replyTexts[i % replyTexts.length] : null,
      meta: { parentJobId, index: i, total: ordered.length },
    },
    opts: { delay: Math.round(i * (minD + Math.random() * (maxD - minD))), attempts: 2,
      jobId: `eng-auto-${tweetId}-${account._id}-${Date.now()}` },
  }));

  await queue.addBulk(jobs);
  registry.create({ parentJobId, type: 'engagement', total: jobs.length,
    accountUsernames: ordered.map(w => w.account.username),
    meta: { auto: true, tweetId, mode: hasGroups ? 'per-action' : 'pool', src: label } });
  registry.registerJobs(parentJobId, jobs.map(j => j.opts.jobId));
  logger.info(`[AutoEngage] ${jobs.length} jobs for tweet ${tweetId} (${hasGroups ? 'per-action' : 'pool'}, ${label})`);
  return { parentJobId, jobs: jobs.length };
}

module.exports = { launchAutoEngage };
