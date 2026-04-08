'use strict';
const Account        = require('../models/Account');
const { Content, EngageCampaign, log } = require('../models/index');
const ActionSvc      = require('../services/action.service');
const AISvc          = require('../services/ai.service');
const logger         = require('../utils/logger');

const ActionCtrl = {

  // ── Single tweet ──────────────────────────────────────────────
  async tweet(req, res) {
    const { accountId, text, mediaLocalPaths, replyToTweetId } = req.body;
    if (!accountId || !text) return res.status(400).json({ error: 'accountId and text required' });
    const account = await Account.findById(accountId);
    if (!account?.isOperational) return res.status(400).json({ error: `Account not active: ${account?.status}` });

    const result = await ActionSvc.tweet(account, { text, mediaLocalPaths, replyToTweetId });

    await Content.create({
      account: accountId, text, status: 'منشور',
      publishedAt: new Date(), tweetId: result.tweetId, tweetUrl: result.tweetUrl,
    });
    res.json(result);
  },

  // ── Multi-account tweet ───────────────────────────────────────
  // Post same text (or AI-varied text) to multiple accounts with delay
  async tweetMulti(req, res) {
    const { accountIds, text, varyText = false, delayMinMs = 8000, delayMaxMs = 25000, topic, hashtags } = req.body;
    const actualTopic = topic || text;
    if (!accountIds?.length || !text) return res.status(400).json({ error: 'accountIds[] and text required' });

    const accounts = await Account.find({ _id: { $in: accountIds }, isActive: true, status: 'نشط' });
    if (!accounts.length) return res.status(400).json({ error: 'No active accounts found' });

    // Respond immediately, run in background
    res.json({ queued: true, accounts: accounts.map(a => a.username), total: accounts.length });

    // Background execution
    setImmediate(async () => {
      const textFn = varyText
        ? async (account) => {
            try {
              const sugs = await AISvc.suggestTweets({
                niche: account.niche || 'general',
                topic: actualTopic,
                count: 1,
              });
              let generated = sugs[0]?.text || text;
              if (hashtags && !generated.includes(hashtags.split(' ')[0])) {
                generated = generated.trim() + '\n\n' + hashtags;
              }
              if (generated.length > 280) generated = generated.slice(0, 277) + '…';
              return generated;
            } catch { return text; }
          }
        : () => text;

      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        try {
          const t = typeof textFn === 'function' ? await textFn(account) : text;
          const r = await ActionSvc.tweet(account, { text: t });
          await Content.create({
            account: account._id, text: t, status: 'منشور',
            publishedAt: new Date(), tweetId: r.tweetId, tweetUrl: r.tweetUrl,
          });
          // احفظ الجلسة بعد النشر الناجح عشان الحساب التالي يستفيد منها
          await require('../services/browser.service').persistSession(account).catch(() => {});
          if (global.io) global.io.emit('tweet:multi:progress', { username: account.username, done: i+1, total: accounts.length, success: true, tweetId: r.tweetId });
        } catch (e) {
          logger.error(`[TweetMulti] @${account.username}: ${e.message}`);
          if (global.io) global.io.emit('tweet:multi:progress', { username: account.username, done: i+1, total: accounts.length, success: false, error: e.message });
        }
        if (i < accounts.length - 1) {
          const delay = delayMinMs + Math.random() * (delayMaxMs - delayMinMs);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      if (global.io) global.io.emit('tweet:multi:done', { total: accounts.length });
      logger.info(`[TweetMulti] Completed for ${accounts.length} accounts`);
    });
  },

  // ── Follow ────────────────────────────────────────────────────
  async follow(req, res) {
    const { accountId, targetHandle } = req.body;
    if (!accountId || !targetHandle) return res.status(400).json({ error: 'accountId and targetHandle required' });
    const account = await Account.findById(accountId);
    if (!account?.isOperational) return res.status(400).json({ error: 'Account not active' });
    const result = await ActionSvc.follow(account, targetHandle);
    res.json(result);
  },

  // ── Like ──────────────────────────────────────────────────────
  async like(req, res) {
    const { accountId, tweetId } = req.body;
    if (!accountId || !tweetId) return res.status(400).json({ error: 'accountId and tweetId required' });
    const account = await Account.findById(accountId);
    if (!account?.isOperational) return res.status(400).json({ error: 'Account not active' });
    const result = await ActionSvc.like(account, tweetId);
    res.json(result);
  },

  // ── Retweet ───────────────────────────────────────────────────
  async retweet(req, res) {
    const { accountId, tweetId } = req.body;
    if (!accountId || !tweetId) return res.status(400).json({ error: 'accountId and tweetId required' });
    const account = await Account.findById(accountId);
    if (!account?.isOperational) return res.status(400).json({ error: 'Account not active' });
    const result = await ActionSvc.retweet(account, tweetId);
    res.json(result);
  },

  // ── Reply ─────────────────────────────────────────────────────
  async reply(req, res) {
    const { accountId, tweetId, text, useAI = false, aiHint } = req.body;
    if (!accountId || !tweetId) return res.status(400).json({ error: 'accountId, tweetId required' });
    if (!useAI && !text) return res.status(400).json({ error: 'text required when not using AI' });

    const account = await Account.findById(accountId);
    if (!account?.isOperational) return res.status(400).json({ error: 'Account not active' });

    let replyText = text;

    // توليد رد بالـ AI
    if (useAI) {
      try {
        // جلب محتوى التغريدة أولاً
        const tweetContent = await ActionSvc.getTweetText(account, tweetId).catch(() => '');
        const prompt = `${aiHint ? aiHint + '. ' : ''}اكتب رداً طبيعياً ومناسباً على هذه التغريدة باللغة العربية (أقل من 200 حرف): "${tweetContent}"`;
        const sugs = await AISvc.suggestTweets({
          niche:  account.niche || 'general',
          topic:  prompt,
          count:  1,
          style:  'تفاعلي',
        });
        replyText = sugs[0]?.text || aiHint || 'شكراً على المشاركة!';
        if (replyText.length > 280) replyText = replyText.slice(0, 277) + '…';
      } catch (e) {
        logger.warn(`[Reply] AI failed: ${e.message}`);
        replyText = aiHint || 'شكراً على المشاركة!';
      }
    }

    const result = await ActionSvc.reply(account, tweetId, replyText);
    res.json({ ...result, replyText });
  },

  // ── Search ────────────────────────────────────────────────────
  async search(req, res) {
    const { accountId, keyword, maxResults = 20 } = req.body;
    if (!accountId || !keyword) return res.status(400).json({ error: 'accountId and keyword required' });
    const account = await Account.findById(accountId);
    if (!account?.isOperational) return res.status(400).json({ error: 'Account not active' });
    const results = await ActionSvc.search(account, keyword, maxResults);
    res.json({ results, total: results.length });
  },

  // ── Engagement Campaign ───────────────────────────────────────
  // Create a campaign: add tweetUrl + select accounts + pick actions + set counts
  async createCampaign(req, res) {
    const {
      name, tweetUrl,
      accountIds, accountRole, accountTags,
      actions, replyTexts,
      targets, delayMinMs, delayMaxMs,
    } = req.body;

    if (!name || !tweetUrl || !actions?.length) {
      return res.status(400).json({ error: 'name, tweetUrl, actions[] required' });
    }

    // Extract tweet ID from URL
    const tweetId = (tweetUrl.match(/\/status\/(\d+)/) || [])[1] || null;
    if (!tweetId) return res.status(400).json({ error: 'Invalid tweet URL — could not extract tweet ID' });

    const campaign = await EngageCampaign.create({
      name, tweetUrl, tweetId,
      accountIds:   accountIds   || [],
      accountRole:  accountRole  || null,
      accountTags:  accountTags  || [],
      actions,
      replyTexts:   replyTexts   || [],
      targets:      targets      || { likes:0, retweets:0, replies:0 },
      delayMinMs:   delayMinMs   || 5000,
      delayMaxMs:   delayMaxMs   || 15000,
      createdBy: req.user._id,
    });

    res.status(201).json(campaign);
  },

  // ── Run campaign ──────────────────────────────────────────────
  async runCampaign(req, res) {
    const campaign = await EngageCampaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'running') return res.status(400).json({ error: 'Campaign already running' });

    // Resolve accounts
    let accountQuery = { isActive: true, status: 'نشط' };
    if (campaign.accountIds?.length) {
      accountQuery._id = { $in: campaign.accountIds };
    } else if (campaign.accountRole) {
      accountQuery.role = campaign.accountRole;
    } else if (campaign.accountTags?.length) {
      accountQuery.tags = { $in: campaign.accountTags };
    }
    const accounts = await Account.find(accountQuery);
    if (!accounts.length) return res.status(400).json({ error: 'No active accounts match this campaign' });

    campaign.status    = 'running';
    campaign.startedAt = new Date();
    await campaign.save();

    res.json({ started: true, accounts: accounts.map(a => a.username), total: accounts.length });

    // Background run
    setImmediate(async () => {
      try {
        const results = await ActionSvc.engageTweet(
          accounts, campaign.tweetId, campaign.actions,
          { replyTexts: campaign.replyTexts, delayBetweenMs: [campaign.delayMinMs, campaign.delayMaxMs] }
        );

        campaign.status     = 'done';
        campaign.finishedAt = new Date();
        campaign.results    = results;
        await campaign.save();

        if (global.io) global.io.emit('campaign:done', { campaignId: campaign._id, name: campaign.name, results });
        logger.info(`[Campaign] "${campaign.name}" done — ${accounts.length} accounts`);
      } catch (e) {
        campaign.status  = 'failed';
        campaign.results = { error: e.message };
        await campaign.save();
        logger.error(`[Campaign] "${campaign.name}" failed: ${e.message}`);
      }
    });
  },

  async listCampaigns(req, res) {
    const campaigns = await EngageCampaign.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ campaigns, total: campaigns.length });
  },

  async getCampaign(req, res) {
    const campaign = await EngageCampaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ error: 'Not found' });
    res.json(campaign);
  },

  async cancelCampaign(req, res) {
    const campaign = await EngageCampaign.findByIdAndUpdate(req.params.id, { status: 'cancelled' }, { new: true });
    res.json(campaign);
  },

  // ── AI suggestions ────────────────────────────────────────────
  async suggestTweets(req, res) {
    const { accountId, topic, count = 3, style } = req.body;
    const account = await Account.findById(accountId).select('-credentials').lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const recent = (await Content.find({ account: accountId, status: 'منشور' })
      .sort({ publishedAt: -1 }).limit(15).select('text').lean()).map(c => c.text);

    const suggestions = await AISvc.suggestTweets({
      niche: account.niche || 'general', style: style || 'educational',
      topic, count, recentTweets: recent,
    });

    const drafts = await Promise.all(suggestions.map(s =>
      Content.create({ account: accountId, text: s.text, status: 'مسودة', aiGenerated: true, qualityScore: s.qualityScore, riskScore: s.riskScore, aiSuggestion: s.note })
    ));

    res.json({ suggestions, drafts: drafts.map(d => d._id) });
  },

  async suggestReplies(req, res) {
    const { accountId, originalText, count = 2 } = req.body;
    const account = await Account.findById(accountId).select('-credentials').lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const suggestions = await AISvc.suggestReplies({ originalTweet: originalText, niche: account.niche || 'general', count });
    res.json({ suggestions });
  },

  async scoreContent(req, res) {
    const { text, accountId } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const account = accountId ? await Account.findById(accountId).select('niche').lean() : null;
    const result  = await AISvc.scoreContent(text, account?.niche);
    res.json(result);
  },

  async analyzeRisk(req, res) {
    const { accountId, plannedActions = [] } = req.body;
    const account = await Account.findById(accountId).lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const oneHour   = new Date(Date.now() - 3_600_000);
    const { ActivityLog } = require('../models/index');
    const recent    = await ActivityLog.find({ account: accountId, category: 'engage', createdAt: { $gte: oneHour } }).lean();
    const recentAct = recent.reduce((a,l) => { a[l.action]=(a[l.action]||0)+1; return a; }, {});
    const result    = await AISvc.analyzeRisk({ username: account.username, recentActivity: recentAct, plannedActions });
    res.json(result);
  },
};

module.exports = ActionCtrl;