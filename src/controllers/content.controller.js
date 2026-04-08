'use strict';
const { Content, Schedule } = require('../models/index');
const Account   = require('../models/Account');
const ActionSvc = require('../services/action.service');

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
    const { accountId, text, scheduledAt, tags, replyToTweetId } = req.body;
    if (!accountId || !text) return res.status(400).json({ error: 'accountId and text required' });
    const account = await Account.findById(accountId).lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const item = await Content.create({
      account: accountId, text, niche: account.niche,
      status: scheduledAt ? 'مجدول' : 'مسودة',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      tags, replyToTweetId,
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
    res.json({ success: true, schedule: entry, content: item });
  },

  async listSchedules(req, res) {
    const { accountId } = req.query;
    const filter = { status:'pending' };
    if (accountId) filter.account = accountId;
    const items = await Schedule.find(filter)
      .populate('account','username').populate('content','text status')
      .sort({ scheduledAt:1 }).lean();
    res.json({ items, total: items.length });
  },

  async cancelSchedule(req, res) {
    await Schedule.findByIdAndUpdate(req.params.id, { status:'cancelled' });
    res.json({ success: true });
  },
};

module.exports = ContentCtrl;
