'use strict';
const { Content, Schedule } = require('../models/index');
const Account   = require('../models/Account');
const ActionSvc = require('../services/action.service');
const { getQueue, QUEUE_NAMES } = require('../queues/queues');
const logger = require('../utils/logger');

async function enqueueScheduledContent(contentId, accountId, scheduledAt, meta = null) {
  const queue = getQueue(QUEUE_NAMES.SCHEDULED_POST);
  const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  await queue.add(
    QUEUE_NAMES.SCHEDULED_POST,
    { contentId: String(contentId), accountId: String(accountId), ...(meta ? { meta } : {}) },
    {
      jobId: `schedpost-${contentId}`, delay,
      attempts: 2, backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: true, removeOnFail: 100,
    },
  );
}

const ContentCtrl = {
  async list(req, res) {
    const { accountId, status, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (accountId) filter.account = accountId;
    if (status)    filter.status  = status;
    const [items, total] = await Promise.all([
      Content.find(filter).populate('account','username niche')
        .sort({ createdAt: -1 }).skip((page-1)*limit).limit(+limit).lean(),
      Content.countDocuments(filter),
    ]);
    res.json({ items, total, page: +page });
  },

  async create(req, res) {
    const { accountId, text, scheduledAt, tags, replyToTweetId, mediaLocalPaths, engage } = req.body;
    if (!accountId || !text) return res.status(400).json({ error: 'accountId and text required' });
    const account = await Account.findById(accountId).lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const item = await Content.create({
      account: accountId, text, niche: account.niche,
      status: scheduledAt ? 'مجدول' : 'مسودة',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      tags, replyToTweetId,
      mediaLocalPaths: Array.isArray(mediaLocalPaths) ? mediaLocalPaths : [],
      ...(engage && engage.enabled ? { engage } : {}),
    });
    res.status(201).json(item);
  },

  async update(req, res) {
    const allowed = ['text','scheduledAt','status','tags'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const item = await Content.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(item);
  },

  async approve(req, res) {
    const item = await Content.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!['مسودة','بانتظار_موافقة'].includes(item.status)) {
      return res.status(400).json({ error: `Cannot approve item in status: ${item.status}` });
    }
    item.status = 'معتمد'; item.approvedBy = req.user._id; item.approvedAt = new Date();
    await item.save();
    res.json({ success: true, item });
  },

  async publishNow(req, res) {
    const item = await Content.findById(req.params.id).populate('account');
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!item.account?.isOperational) return res.status(400).json({ error: 'Account not active' });
    try {
      const result = await ActionSvc.tweet(item.account, { text: item.text, replyToTweetId: item.replyToTweetId });
      item.status = 'منشور'; item.publishedAt = new Date(); item.tweetId = result.tweetId; item.tweetUrl = result.tweetUrl;
      await item.save();
      res.json({ success: true, result });
    } catch (e) {
      item.status = 'فشل'; item.failReason = e.message; item.retryCount++;
      await item.save();
      res.status(500).json({ error: e.message });
    }
  },

  async cancel(req, res) {
    const item = await Content.findByIdAndUpdate(req.params.id, { $set: { status:'ملغى', rejectionNote: req.body.note } }, { new:true });
    res.json(item);
  },

  async remove(req, res) {
    const item = await Content.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.status === 'منشور') return res.status(400).json({ error: 'Cannot delete published content' });
    await item.deleteOne();
    res.json({ success: true });
  },

  async schedule(req, res) {
    const { accountId, contentId, scheduledAt } = req.body;
    if (!accountId || !scheduledAt) return res.status(400).json({ error: 'accountId and scheduledAt required' });
    let item;
    if (contentId) {
      item = await Content.findByIdAndUpdate(contentId, { $set: { status:'مجدول', scheduledAt: new Date(scheduledAt) } }, { new:true });
    } else if (req.body.text) {
      item = await Content.create({ account: accountId, text: req.body.text, status:'مجدول', scheduledAt: new Date(scheduledAt) });
    } else {
      return res.status(400).json({ error: 'contentId or text required' });
    }
    const entry = await Schedule.create({
      account: accountId, content: item._id, type:'post',
      scheduledAt: new Date(scheduledAt), createdBy: req.user._id,
    });
    await enqueueScheduledContent(item._id, accountId, scheduledAt).catch(error => {
      logger.warn(`[Schedule] delayed queue unavailable; cron fallback will publish ${item._id}: ${error.message}`);
    });
    res.json({ success: true, schedule: entry, content: item });
  },

  async bulkSchedule(req, res) {
    const {
      accountIds = [], textsList = [], textOrder = 'sequential', scheduledAt,
      mediaLocalPaths = [], imageOrder = 'same', engage, requestId, batchSize = 1,
    } = req.body;
    if (!accountIds.length || !textsList.length || !scheduledAt) {
      return res.status(400).json({ error: 'accountIds, textsList and scheduledAt are required' });
    }
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'scheduledAt must be a valid future time' });
    }
    const invalidText = textsList.find(text => !String(text).trim() || String(text).length > 280);
    if (invalidText !== undefined) return res.status(400).json({ error: 'Each post must contain 1-280 characters' });

    const found = await Account.find({ _id: { $in: accountIds }, isActive: true });
    const accountMap = new Map(found.map(account => [account._id.toString(), account]));
    const accounts = accountIds.map(id => accountMap.get(String(id))).filter(Boolean);
    if (!accounts.length) return res.status(400).json({ error: 'No active accounts found' });

    const shuffle = list => [...list].sort(() => Math.random() - 0.5);
    const texts = textOrder === 'random' ? shuffle(textsList) : [...textsList];
    const media = imageOrder === 'random' ? shuffle(mediaLocalPaths) : [...mediaLocalPaths];
    const stableRequestId = String(requestId || `schedule-${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 120);
    const maxConcurrency = Math.max(1, Math.min(accounts.length, Number.parseInt(batchSize, 10) || 1));
    const results = [];

    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index];
      const existing = await Schedule.findOne({ requestId: stableRequestId, account: account._id }).populate('content');
      if (existing) {
        results.push({ accountId: account._id, username: account.username, scheduleId: existing._id, duplicate: true });
        continue;
      }
      const assignedMedia = !media.length ? []
        : imageOrder === 'same' ? media.slice(0, 4)
        : [media[index % media.length]];
      const content = await Content.create({
        account: account._id,
        text: String(texts[index % texts.length]).trim(),
        niche: account.niche,
        status: 'مجدول', scheduledAt: when,
        mediaLocalPaths: assignedMedia,
        ...(engage?.enabled ? { engage } : {}),
      });
      const schedule = await Schedule.create({
        account: account._id, content: content._id, type: 'post',
        scheduledAt: when, createdBy: req.user._id, requestId: stableRequestId, maxConcurrency,
      });
      await enqueueScheduledContent(content._id, account._id, when, {
        parentJobId: stableRequestId, maxConcurrency,
      }).catch(error => logger.warn(`[Schedule] cron fallback for ${content._id}: ${error.message}`));
      results.push({ accountId: account._id, username: account.username, contentId: content._id, scheduleId: schedule._id });
    }

    res.status(201).json({ success: true, total: results.length, requestId: stableRequestId, items: results });
  },

  async listSchedules(req, res) {
    const { accountId } = req.query;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (accountId) filter.account = accountId;
    const items = await Schedule.find(filter)
      .populate('account','username').populate('content','text status failReason tweetUrl mediaLocalPaths')
      .sort({ scheduledAt:-1 }).limit(100).lean();
    res.json({ items, total: items.length });
  },

  async cancelSchedule(req, res) {
    const schedule = await Schedule.findByIdAndUpdate(req.params.id, { status:'cancelled' }, { new:true });
    if (schedule?.content) {
      await Content.findByIdAndUpdate(schedule.content, { status:'ملغى' }).catch(() => {});
      const job = await getQueue(QUEUE_NAMES.SCHEDULED_POST).getJob(`schedpost-${schedule.content}`).catch(() => null);
      if (job) await job.remove().catch(() => {});
    }
    res.json({ success: true });
  },

  async retrySchedule(req, res) {
    const schedule = await Schedule.findById(req.params.id);
    if (!schedule?.content) return res.status(404).json({ error: 'Schedule not found' });
    const when = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : new Date(Date.now() + 5_000);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid scheduledAt' });
    schedule.status = 'pending';
    schedule.scheduledAt = when;
    await schedule.save();
    await Content.findByIdAndUpdate(schedule.content, {
      $set:{ status:'مجدول', scheduledAt:when }, $unset:{ failReason:1 },
    });
    const oldJob = await getQueue(QUEUE_NAMES.SCHEDULED_POST).getJob(`schedpost-${schedule.content}`).catch(() => null);
    if (oldJob) await oldJob.remove().catch(() => {});
    await enqueueScheduledContent(schedule.content, schedule.account, when, schedule.requestId ? {
      parentJobId: schedule.requestId, maxConcurrency: schedule.maxConcurrency || 1,
    } : null).catch(error => logger.warn(`[Schedule] retry queued for cron fallback: ${error.message}`));
    res.json({ success:true, schedule });
  },
};

module.exports = ContentCtrl;
