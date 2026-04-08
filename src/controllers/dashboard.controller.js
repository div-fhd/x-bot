'use strict';
const Account  = require('../models/Account');
const { Content, ActivityLog, RiskEvent } = require('../models/index');
const Browser  = require('../services/browser.service');

const DashCtrl = {
  async overview(req, res) {
    const today = new Date(new Date().setHours(0,0,0,0));
    const [total, byStatus, byRole, todayActions, published, failed, openRisks, recentLogs] = await Promise.all([
      Account.countDocuments({ isActive:true }),
      Account.aggregate([{ $match:{ isActive:true } }, { $group:{ _id:'$status', count:{ $sum:1 } } }]),
      Account.aggregate([{ $match:{ isActive:true } }, { $group:{ _id:'$role',   count:{ $sum:1 } } }]),
      ActivityLog.countDocuments({ createdAt:{ $gte:today } }),
      Content.countDocuments({ status:'منشور', publishedAt:{ $gte:today } }),
      Content.countDocuments({ status:'فشل',   updatedAt:{ $gte:today } }),
      RiskEvent.countDocuments({ resolved:false }),
      ActivityLog.find().sort({ createdAt:-1 }).limit(15).populate('account','username').lean(),
    ]);
    const sm = byStatus.reduce((a,s)=>{ a[s._id]=s.count; return a; }, {});
    const rm = byRole.reduce((a,r)=>{ a[r._id]=r.count; return a; }, {});
    res.json({
      accounts: {
        total, active: sm['نشط']||0, needAuth: sm['يحتاج_مصادقة']||0,
        checkpoint: sm['نقطة_تحقق']||0, restricted: sm['محظور']||0,
        inactive: sm['غير_نشط']||0, suspended: sm['موقوف']||0,
        byRole: rm,
      },
      today: {
        actions: todayActions, published, failed,
        successRate: published+failed ? +((published/(published+failed))*100).toFixed(1) : null,
      },
      alerts: { openRisks },
      browser: Browser.stats(),
      recentActivity: recentLogs.map(l => ({
        id: l._id, account: l.account?.username, category: l.category,
        action: l.action, result: l.result, createdAt: l.createdAt,
      })),
    });
  },

  async activityChart(req, res) {
    const days  = parseInt(req.query.days || '7', 10);
    const since = new Date(Date.now() - days * 86_400_000);
    const data  = await ActivityLog.aggregate([
      { $match: { createdAt:{ $gte:since }, result:'success' } },
      { $group: { _id:{ date:{ $dateToString:{ format:'%Y-%m-%d', date:'$createdAt' } }, category:'$category' }, count:{ $sum:1 } } },
      { $sort: { '_id.date':1 } },
    ]);
    res.json({ data, since, days });
  },

  async risks(req, res) {
    const risks = await RiskEvent.find({ resolved:false })
      .populate('account','username status').sort({ createdAt:-1 }).limit(100).lean();
    const summary = risks.reduce((a,r)=>{ a[r.level]=(a[r.level]||0)+1; return a; }, {});
    res.json({ risks, summary, total: risks.length });
  },

  async resolveRisk(req, res) {
    const event = await RiskEvent.findByIdAndUpdate(req.params.id, {
      resolved:true, resolvedAt:new Date(), resolvedBy:req.user._id, resolution:req.body.resolution,
    }, { new:true });
    if (!event) return res.status(404).json({ error: 'Not found' });
    res.json(event);
  },

  async auditLog(req, res) {
    const { accountId, category, result, page=1, limit=100 } = req.query;
    const filter = {};
    if (accountId) filter.account  = accountId;
    if (category)  filter.category = category;
    if (result)    filter.result   = result;
    const [logs, total] = await Promise.all([
      ActivityLog.find(filter).populate('account','username').sort({ createdAt:-1 }).skip((page-1)*limit).limit(+limit).lean(),
      ActivityLog.countDocuments(filter),
    ]);
    res.json({ logs, total, page:+page });
  },
};

module.exports = DashCtrl;
