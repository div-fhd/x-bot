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
    const { name, tweetUrl, accountIds, accountRole, actions, replyTexts = [], quoteMode = 'manual', quoteTexts = [], quotePrompt = '', delayMinMs = 8000, delayMaxMs = 25000, scheduleAt, authorHandle, runMode = 'sequential', parallelCount = 1 } = req.body;
    if (!name || !tweetUrl || !actions?.length)
      return res.status(400).json({ error: 'name, tweetUrl, actions required' });

    const tweetId = extractTweetId(tweetUrl);
    if (!tweetId) return res.status(400).json({ error: 'Invalid tweet URL' });

    const campaign = await EngageCampaign.create({
      name, tweetUrl, tweetId, accountIds, accountRole, actions,
      replyTexts, quoteMode, quoteTexts, quotePrompt,
      delayMinMs, delayMaxMs, scheduleAt,
      runMode, parallelCount,
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

    // Resolve accounts
    let accounts;
    if (campaign.accountIds?.length) {
      accounts = await Account.find({ _id: { $in: campaign.accountIds }, isActive: true, status: 'active' });
    } else if (campaign.accountRole) {
      accounts = await Account.find({ role: campaign.accountRole, isActive: true, status: 'active' });
    } else {
      accounts = await Account.find({ isActive: true, status: 'active' });
    }

    if (!accounts.length) return res.status(400).json({ error: 'No active accounts found' });

    // Randomize order — anti-pattern
    const shuffled = shuffle(accounts);
    const queue    = getQueue(QUEUE_NAMES.ENGAGEMENT);
    const parentJobId = `engagement-${campaign._id}-${Date.now()}`;

    // Build jobs respecting runMode
    const runMode      = campaign.runMode      || 'sequential';
    const parallelCount = runMode === 'parallel'
      ? Math.max(1, Math.min(campaign.parallelCount || 3, 10))
      : 1;

    const jobs = [];
    for (let i = 0; i < shuffled.length; i++) {
      const account   = shuffled[i];
      const replyText = campaign.replyTexts?.length
        ? campaign.replyTexts[i % campaign.replyTexts.length]
        : null;

      // ── Delay calculation ───────────────────────────────────
      // sequential: كل job ينتظر دوره الكامل قبله
      // parallel:   نقسّم لمجموعات — كل مجموعة لها delay موحّد
      let delay;
      if (runMode === 'sequential') {
        // الـ delay يضمن إن الـ job السابق خلّص قبل بدء هذا
        // نقدّر متوسط وقت العملية بـ 60 ثانية + التأخير المضبوط
        const avgJobMs = 60_000 + campaign.delayMaxMs;
        delay = Math.round(i * avgJobMs);
      } else {
        // parallel: مجموعات بحجم parallelCount
        const groupIndex = Math.floor(i / parallelCount);
        const avgJobMs   = 60_000 + campaign.delayMaxMs;
        delay = Math.round(groupIndex * avgJobMs);
      }

      jobs.push({
        name: QUEUE_NAMES.ENGAGEMENT,
        data: {
          accountId:    account._id.toString(),
          campaignId:   campaign._id.toString(),
          actions:      campaign.actions,
          tweetId:      campaign.tweetId,
          tweetUrl:     campaign.tweetUrl,
          replyText,
          quoteMode:    campaign.quoteMode   || 'manual',
          quoteTexts:   campaign.quoteTexts  || [],
          quotePrompt:  campaign.quotePrompt || '',
          authorHandle: campaign.meta?.authorHandle,
          meta: {
            parentJobId,
            index:        i,
            total:        shuffled.length,
            authorHandle: campaign.meta?.authorHandle,
          },
        },
        opts: {
          delay,
          jobId: `eng-${campaign._id}-${account._id}-${Date.now()}`,
          attempts: 2,
          backoff: { type: 'fixed', delay: 10_000 },
        },
      });
    }

    // totals already correct (set per job)

    await queue.addBulk(jobs);

    // Register in ops registry
    registry.create({
      parentJobId, type: 'engagement',
      total: jobs.length,
      accountUsernames: shuffled.map(a => a.username),
      meta: { campaignId: campaign._id.toString(), tweetId: campaign.tweetId, actions: campaign.actions },
    });
    registry.registerJobs(parentJobId, jobs.map(j => j.opts.jobId));

    await EngageCampaign.updateOne({ _id: campaign._id }, { status: 'running', startedAt: new Date() });

    logger.info(`[Engagement] Campaign "${campaign.name}" launched — ${jobs.length} jobs → ${parentJobId}`);
    res.json({ started: true, jobId: parentJobId, total: jobs.length, accounts: shuffled.length });
  },

  // POST /api/v1/engagement/:id/cancel
  async cancel(req, res) {
    await EngageCampaign.updateOne({ _id: req.params.id }, { status: 'cancelled' });
    res.json({ cancelled: true });
  },

  // DELETE /api/v1/engagement/:id
  async remove(req, res) {
    await EngageCampaign.deleteOne({ _id: req.params.id });
    res.json({ deleted: true });
  },
};