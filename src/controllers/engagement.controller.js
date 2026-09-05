'use strict';
const { EngageCampaign, log } = require('../models/index');
const Account                  = require('../models/Account');
const { getQueue, QUEUE_NAMES } = require('../queues/queues');
const { registry }              = require('../ops/operations.registry');
const logger                    = require('../utils/logger');

// ── Extract tweet ID from URL or raw ID ──────────────────────
function extractTweetId(val) {
  if (!val) return null;
  const m = String(val).match(/status\/(\d+)/);
  return m ? m[1] : val.replace(/\D/g, '');
}

// ── Shuffle array ────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {

  // GET /api/v1/engagement
  async list(req, res) {
    const { status, limit = 20, page = 1 } = req.query;
    const query = status ? { status } : {};
    const [campaigns, total] = await Promise.all([
      EngageCampaign.find(query).sort({ createdAt: -1 }).limit(+limit).skip((page-1)*limit).lean(),
      EngageCampaign.countDocuments(query),
    ]);
    res.json({ campaigns, total, page: +page });
  },

  // POST /api/v1/engagement
  async create(req, res) {
    const { name, tweetUrl, accountIds, accountRole, accountTags = [], actions, actionGroups = {}, replyTexts = [], quoteMode = 'manual', quoteTexts = [], quotePrompt = '', delayMinMs = 0, delayMaxMs = 0, scheduleAt, authorHandle, runMode = 'sequential', parallelCount = 1, targets } = req.body;

    // أفعال الحملة: إمّا قائمة عامة (actions) أو مستنبطة من actionGroups
    const groupActions = Object.entries(actionGroups || {}).filter(([, ids]) => Array.isArray(ids) && ids.length).map(([a]) => a);
    const effectiveActions = (actions?.length ? actions : groupActions);
    if (!name || !tweetUrl || !effectiveActions.length)
      return res.status(400).json({ error: 'name, tweetUrl, and at least one action (actions or actionGroups) required' });

    const tweetId = extractTweetId(tweetUrl);
    if (!tweetId) return res.status(400).json({ error: 'Invalid tweet URL' });

    const campaign = await EngageCampaign.create({
      name, tweetUrl, tweetId, accountIds, accountRole, accountTags,
      actions: effectiveActions, actionGroups,
      replyTexts, quoteMode, quoteTexts, quotePrompt,
      delayMinMs, delayMaxMs, scheduleAt,
      runMode, parallelCount,
      // targets: سقف عدد الحسابات لكل فعل (0/غير محدد = بلا حد). model له افتراضي {0,0,0}
      ...(targets ? { targets } : {}),
      meta: { authorHandle },
      createdBy: req.user?._id,
    });

    res.json({ campaign });
  },

  // POST /api/v1/engagement/:id/launch
  async launch(req, res) {
    const campaign = await EngageCampaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'running') return res.status(400).json({ error: 'Already running' });

    // ── ابنِ قائمة العمل: [{ account, actions }] — نمطان ──────────
    const base = { isActive: true, status: 'active' };
    const groups = (campaign.actionGroups && typeof campaign.actionGroups === 'object') ? campaign.actionGroups : {};
    const hasGroups = Object.values(groups).some(a => Array.isArray(a) && a.length);

    let workList = []; // [{ account, actions:[...] }]

    if (hasGroups) {
      // ── (أ) تخصيص بالفعل → اعكس وجمّع بالحساب (كل حساب يسوّي أفعاله في جلسة) ──
      const byAccount = new Map(); // accountId(str) → Set(actions)
      for (const [action, ids] of Object.entries(groups)) {
        if (!Array.isArray(ids)) continue;
        for (const id of ids) {
          const k = String(id);
          if (!byAccount.has(k)) byAccount.set(k, new Set());
          byAccount.get(k).add(action);
        }
      }
      const accs = await Account.find({ ...base, _id: { $in: [...byAccount.keys()] } });
      workList = accs.map(a => ({ account: a, actions: [...byAccount.get(String(a._id))] }));
    } else {
      // ── (ب) النمط القديم: مجموعة واحدة + كل الأفعال + سقوف targets ──
      let accounts;
      if (campaign.accountIds?.length)        accounts = await Account.find({ ...base, _id: { $in: campaign.accountIds } });
      else if (campaign.accountRole)          accounts = await Account.find({ ...base, role: campaign.accountRole });
      else if (campaign.accountTags?.length)  accounts = await Account.find({ ...base, tags: { $in: campaign.accountTags } });
      else                                    accounts = await Account.find(base);

      const caps       = { like: campaign.targets?.likes || 0, retweet: campaign.targets?.retweets || 0, reply: campaign.targets?.replies || 0 };
      const usedPerAct = { like: 0, retweet: 0, reply: 0 };
      for (const account of shuffle(accounts)) {
        const acts = (campaign.actions || []).filter(act => {
          const cap = caps[act] || 0;
          if (cap && usedPerAct[act] >= cap) return false;
          if (act in usedPerAct) usedPerAct[act]++;
          return true;
        });
        if (acts.length) workList.push({ account, actions: acts });
      }
    }

    if (!workList.length) return res.status(400).json({ error: 'No active accounts / actions to run' });

    // ── جدولة + بناء jobs (مشترك للنمطين) ─────────────────────────
    const queue         = getQueue(QUEUE_NAMES.ENGAGEMENT);
    const parentJobId   = `engagement-${campaign._id}-${Date.now()}`;
    const runMode       = campaign.runMode || 'sequential';
    const parallelCount = runMode === 'parallel' ? Math.max(1, Math.min(campaign.parallelCount || 3, 10)) : 1;

    const entries = hasGroups ? shuffle(workList) : workList; // القديم مخلوط أصلاً
    const EST_JOB_MS = 60_000;
    const dMin   = Math.max(0, campaign.delayMinMs ?? 8000);
    const dMax   = Math.max(dMin, campaign.delayMaxMs ?? 25000);
    const jitter = () => dMin + Math.random() * (dMax - dMin);

    const jobs = [];
    let cursorMs = 0, groupFill = 0;
    for (const { account, actions } of entries) {
      const replyText = (actions.includes('reply') && campaign.replyTexts?.length)
        ? campaign.replyTexts[jobs.length % campaign.replyTexts.length] : null;

      const delay = Math.round(cursorMs);
      if (runMode === 'sequential') cursorMs += EST_JOB_MS + jitter();
      else if (++groupFill >= parallelCount) { groupFill = 0; cursorMs += EST_JOB_MS + jitter(); }

      jobs.push({
        name: QUEUE_NAMES.ENGAGEMENT,
        data: {
          accountId:    account._id.toString(),
          campaignId:   campaign._id.toString(),
          actions,
          tweetId:      campaign.tweetId,
          tweetUrl:     campaign.tweetUrl,
          replyText,
          quoteMode:    campaign.quoteMode   || 'manual',
          quoteTexts:   campaign.quoteTexts  || [],
          quotePrompt:  campaign.quotePrompt || '',
          authorHandle: campaign.meta?.authorHandle,
          meta: { parentJobId, index: 0, total: 0, authorHandle: campaign.meta?.authorHandle },
        },
        opts: {
          delay,
          jobId: `eng-${campaign._id}-${account._id}-${Date.now()}`,
          attempts: 2,
          backoff: { type: 'fixed', delay: 10_000 },
        },
        _username: account.username,
      });
    }

    if (!jobs.length) return res.status(400).json({ error: 'لا توجد أفعال للتنفيذ' });

    const accountUsernames = jobs.map(j => j._username);
    jobs.forEach((j, idx) => { j.data.meta.index = idx; j.data.meta.total = jobs.length; delete j._username; });

    await queue.addBulk(jobs);

    registry.create({
      parentJobId, type: 'engagement',
      total: jobs.length,
      accountUsernames,
      meta: { campaignId: campaign._id.toString(), tweetId: campaign.tweetId, mode: hasGroups ? 'per-action' : 'pool' },
    });
    registry.registerJobs(parentJobId, jobs.map(j => j.opts.jobId));

    await EngageCampaign.updateOne(
      { _id: campaign._id },
      { status: 'running', startedAt: new Date(), 'meta.parentJobId': parentJobId },
    );

    logger.info(`[Engagement] Campaign "${campaign.name}" launched — ${jobs.length} jobs on ${accountUsernames.length} accounts → ${parentJobId}`);
    res.json({ started: true, jobId: parentJobId, total: jobs.length, accounts: accountUsernames.length });
  },

  // POST /api/v1/engagement/:id/cancel
  async cancel(req, res) {
    const campaign = await EngageCampaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // ألغِ العملية في الـ registry — يحذف الـ jobs المؤجّلة ويوقف النشطة ويغلق الـ contexts
    const parentJobId = campaign.meta?.parentJobId;
    if (parentJobId) {
      await registry.cancel(parentJobId).catch(e =>
        logger.warn(`[Engagement] cancel registry error: ${e.message}`));
    }

    await EngageCampaign.updateOne({ _id: req.params.id }, { status: 'cancelled' });
    logger.info(`[Engagement] Campaign "${campaign.name}" cancelled${parentJobId ? ` (${parentJobId})` : ''}`);
    res.json({ cancelled: true });
  },

  // DELETE /api/v1/engagement/:id
  async remove(req, res) {
    await EngageCampaign.deleteOne({ _id: req.params.id });
    res.json({ deleted: true });
  },
};
