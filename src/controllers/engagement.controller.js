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
    const { name, tweetUrl, accountIds, accountRole, actions, replyTexts = [], delayMinMs = 8000, delayMaxMs = 25000, scheduleAt } = req.body;
    if (!name || !tweetUrl || !actions?.length)
      return res.status(400).json({ error: 'name, tweetUrl, actions required' });

    const tweetId = extractTweetId(tweetUrl);
    if (!tweetId) return res.status(400).json({ error: 'Invalid tweet URL' });

    const campaign = await EngageCampaign.create({
      name, tweetUrl, tweetId, accountIds, accountRole, actions,
      replyTexts, delayMinMs, delayMaxMs, scheduleAt,
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

    // Build jobs: for each action × account
    const jobs = [];
    for (const action of campaign.actions) {
      const accountsForAction = shuffle(shuffled); // different order per action
      for (let i = 0; i < accountsForAction.length; i++) {
        const account = accountsForAction[i];
        // Stagger: delay increases per account + random jitter
        const baseDelay = i * (campaign.delayMinMs + Math.random() * (campaign.delayMaxMs - campaign.delayMinMs));
        // Action offset — likes first, then retweets, then replies
        const actionOffset = { like: 0, retweet: 5000, reply: 10000, follow_author: 15000 }[action] || 0;
        const replyText = action === 'reply' && campaign.replyTexts?.length
          ? campaign.replyTexts[i % campaign.replyTexts.length]
          : null;

        jobs.push({
          name: QUEUE_NAMES.ENGAGEMENT,
          data: {
            accountId:  account._id.toString(),
            campaignId: campaign._id.toString(),
            action,
            tweetId:    campaign.tweetId,
            tweetUrl:   campaign.tweetUrl,
            replyText,
            meta: {
              parentJobId,
              index:        jobs.length,
              total:        campaign.actions.length * shuffled.length,
              authorHandle: campaign.meta?.authorHandle,
            },
          },
          opts: {
            delay: Math.round(baseDelay + actionOffset),
            jobId: `eng-${campaign._id}-${action}-${account._id}-${Date.now()}`,
            attempts: 2,
            backoff: { type: 'fixed', delay: 10000 },
          },
        });
      }
    }

    // Update total now that we know it
    jobs.forEach((j, i) => { j.data.meta.index = i; j.data.meta.total = jobs.length; });

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