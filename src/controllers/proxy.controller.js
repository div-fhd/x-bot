'use strict';
const mongoose = require('mongoose');
const Account  = require('../models/Account');

// ── Proxy Model ─────────────────────────────────────────────────
const ProxySchema = new mongoose.Schema({
  name: { type: String, required: true },
  url:  { type: String, required: true },
}, { timestamps: true });

const Proxy = mongoose.models.Proxy || mongoose.model('Proxy', ProxySchema);

module.exports = {

  // ── قائمة البروكسيات ──────────────────────────────────────────
  async list(req, res) {
    const proxies = await Proxy.find().sort({ createdAt: -1 }).lean();
    for (const p of proxies) {
      p.accountCount = await Account.countDocuments({ 'network.proxyUrl': p.url });
    }
    res.json({ proxies });
  },

  // ── إضافة بروكسي ──────────────────────────────────────────────
  async create(req, res) {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name وurl مطلوبان' });
    if (!url.startsWith('http')) return res.status(400).json({ error: 'رابط البروكسي غير صحيح — يجب أن يبدأ بـ http' });
    const proxy = await Proxy.create({ name, url });
    res.status(201).json({ proxy });
  },

  // ── تعديل بروكسي ──────────────────────────────────────────────
  async update(req, res) {
    const { name, url } = req.body;
    const old = await Proxy.findById(req.params.id);
    if (!old) return res.status(404).json({ error: 'غير موجود' });
    // لو الـ url تغير — حدّث الحسابات
    if (url && url !== old.url) {
      await Account.updateMany({ 'network.proxyUrl': old.url }, { $set: { 'network.proxyUrl': url } });
    }
    const proxy = await Proxy.findByIdAndUpdate(req.params.id, { name, url }, { new: true });
    res.json({ proxy });
  },

  // ── حذف بروكسي ────────────────────────────────────────────────
  async remove(req, res) {
    const proxy = await Proxy.findById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'غير موجود' });
    await Account.updateMany({ 'network.proxyUrl': proxy.url }, { $unset: { 'network.proxyUrl': '' } });
    await proxy.deleteOne();
    res.json({ success: true });
  },

  // ── تعيين بروكسي على حسابات ───────────────────────────────────
  async assign(req, res) {
    const { proxyId, accountIds } = req.body;
    if (!proxyId || !accountIds?.length) return res.status(400).json({ error: 'proxyId وaccountIds مطلوبان' });
    const proxy = await Proxy.findById(proxyId);
    if (!proxy) return res.status(404).json({ error: 'البروكسي غير موجود' });
    const result = await Account.updateMany(
      { _id: { $in: accountIds } },
      { $set: { 'network.proxyUrl': proxy.url } }
    );
    res.json({ updated: result.modifiedCount, proxyUrl: proxy.url });
  },

  // ── توزيع تلقائي ──────────────────────────────────────────────
  async autoDistribute(req, res) {
    const proxies  = await Proxy.find().lean();
    if (!proxies.length) return res.status(400).json({ error: 'لا توجد بروكسيات' });
    const accounts = await Account.find({ isActive: true }).select('_id').lean();
    if (!accounts.length) return res.json({ updated: 0 });
    let updated = 0;
    for (let i = 0; i < accounts.length; i++) {
      const proxy = proxies[i % proxies.length];
      await Account.findByIdAndUpdate(accounts[i]._id, { $set: { 'network.proxyUrl': proxy.url } });
      updated++;
    }
    res.json({ updated, proxies: proxies.length, accounts: accounts.length });
  },

  // ── إزالة بروكسي من حسابات محددة ─────────────────────────────
  async removeFromAccounts(req, res) {
    const { accountIds } = req.body;
    if (!accountIds?.length) return res.status(400).json({ error: 'accountIds مطلوب' });
    const result = await Account.updateMany(
      { _id: { $in: accountIds } },
      { $unset: { 'network.proxyUrl': '' } }
    );
    res.json({ updated: result.modifiedCount });
  },
};