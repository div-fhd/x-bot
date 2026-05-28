'use strict';
const Account  = require('../models/Account');
const { getQueue, QUEUE_NAMES } = require('../queues/queues');
const { User, log } = require('../models/index');
const Vault    = require('../services/vault.service');
const AuthSvc  = require('../services/auth.service');
const ActionSvc= require('../services/action.service');
const AISvc    = require('../services/ai.service');
const { parseBulkText } = require('../utils/parser');
const logger   = require('../utils/logger');

const AccountCtrl = {

  async list(req, res) {
    const { status, role, page = 1, limit = 50, q, isPrimary } = req.query;
    const filter = { isActive: true };
    if (status)    filter.status    = status;
    if (role)      filter.role      = role;
    if (q)         filter.username  = { $regex: q, $options: 'i' };
    if (isPrimary) filter.isPrimary = true;
    // تطبيق حد عدد الحسابات للمشترك
    const maxAcc = req.user?.permissions?.maxAccounts;
    const effectiveLimit = maxAcc ? Math.min(+limit, maxAcc) : +limit;
    const [accounts, total] = await Promise.all([
      Account.find(filter).select('-credentials').sort({ createdAt: -1 })
        .skip((page-1)*limit).limit(+limit).lean(),
      Account.countDocuments(filter),
    ]);
    res.json({ accounts, total, page: +page, pages: Math.ceil(total/limit) });
  },

  async get(req, res) {
    const a = await Account.findById(req.params.id).lean();
    if (!a) return res.status(404).json({ error: 'Account not found' });
    // فك تشفير بيانات الدخول لعرضها في صفحة التعديل
    try {
      const creds = Vault.decryptAccount(a.credentials || {});
      a.email         = creds.email         || '';
      a.auth_token    = creds.auth_token     || '';
      a.session_token = creds.session_token  || '';
      a.totp_secret   = creds.totp_secret    || '';
      a.mail_password = creds.mail_password  || '';
    } catch {}
    delete a.credentials;
    res.json(a);
  },

  async create(req, res) {
    const { username, password, email, session_token, auth_token, totp_secret,
            proxy_url, niche, label, tags, timezone, dailyCaps, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const handle = username.replace('@','').trim();
    if (await Account.exists({ username: handle })) {
      return res.status(409).json({ error: `@${handle} already exists` });
    }
    const creds = Vault.encryptAccount({ password, email, session_token, auth_token, totp_secret });
    const account = await Account.create({
      username: handle, label: label || `@${handle}`,
      niche, tags: tags || [], role: role || 'mixed',
      credentials: creds,
      ownedBy: req.user._id,
      network: { proxyUrl: proxy_url, timezone: timezone || 'Asia/Riyadh' },
      dailyCaps: dailyCaps || {},
    });
    logger.info(`[Account] Created: @${handle}`);
    res.status(201).json({ account: { ...account.toObject(), credentials: undefined } });
  },

  async bulkImport(req, res) {
    const { text, defaultNiche, defaultTimezone, defaultRole, stagger = 'staggered', updateExisting = false } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const { valid, invalid, total } = parseBulkText(text);
    if (!valid.length) return res.status(400).json({ error: 'No valid accounts found', invalid, total });

    const results = { created: [], updated: [], skipped: [], errors: [] };

    for (let i = 0; i < valid.length; i++) {
      const row = valid[i];
      try {
        const existing = await Account.findOne({ username: row.username });
        if (existing) {
          if (!updateExisting) { results.skipped.push(row.username); continue; }
          // تحديث بيانات الحساب الموجود
          const creds = Vault.encryptAccount(row);
          existing.credentials = creds;
          if (row.proxy_url)    existing.network = { ...existing.network, proxyUrl: row.proxy_url };
          if (defaultRole)      existing.role    = defaultRole;
          if (defaultNiche)     existing.niche   = defaultNiche;
          await existing.save();
          results.updated.push(row.username);
          logger.info(`[Import] Updated: @${row.username}`);
          continue;
        }
        const creds = Vault.encryptAccount(row);
        const account = await Account.create({
          username: row.username,
          label:    `@${row.username}`,
          niche:    defaultNiche || '',
          role:     defaultRole  || 'mixed',
          credentials: creds,
          ownedBy: req.user._id,
          network: { proxyUrl: row.proxy_url || null, timezone: defaultTimezone || 'Asia/Riyadh' },
        });

        results.created.push(row.username);

        // الفحص التلقائي
        if (stagger !== 'manual') {
          const delayMs = stagger === 'safe' ? 120_000 : 30_000;
          setImmediate(async () => {
            try {
              const acc = await Account.findOne({ username: row.username });
              if (!acc) return;
              const AuthSvc = require('../services/auth.service');
              await AuthSvc.checkHealth(acc);
              logger.info(`[Import] فحص @${row.username} ✓`);
            } catch(e) {
              logger.warn(`[Import] فحص @${row.username}: ${e.message}`);
            }
          });
          if (i < valid.length - 1) await new Promise(r => setTimeout(r, delayMs));
        }
      } catch (e) {
        results.errors.push({ username: row.username, error: e.message });
      }
    }

    logger.info(`[Import] created:${results.created.length} skipped:${results.skipped.length} errors:${results.errors.length}`);
    res.json({
      results,
      summary: { total, created: results.created.length, skipped: results.skipped.length, errors: results.errors.length },
      invalid,
    });
  },

  async update(req, res) {
    const allowed = ['label','niche','tags','role','network','features','dailyCaps','notes','status','isPrimary'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const a = await Account.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true }).select('-credentials');
    if (!a) return res.status(404).json({ error: 'Account not found' });
    res.json(a);
  },

  async updateCredentials(req, res) {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const current = Vault.decryptAccount(account.credentials);
    account.credentials = Vault.encryptAccount({
      password:      req.body.password      || current.password,
      email:         req.body.email         || current.email,
      session_token: req.body.session_token || current.session_token,
      auth_token:    req.body.auth_token    || current.auth_token,
      totp_secret:   req.body.totp_secret   || current.totp_secret,
    });
    // إذا تغير الـ auth_token → أعد المصادقة، وإلا احتفظ بالحالة الحالية
    const tokenChanged = req.body.auth_token && req.body.auth_token !== current.auth_token;
    if (tokenChanged) {
      await Vault.deleteSession(account._id.toString());
      account.status     = 'needs_auth';
      account.statusNote = 'Credentials updated';
    }
    await account.save();
    logger.info(`[Account] Credentials updated: @${account.username}`);
    res.json({ success: true });
  },

  async remove(req, res) {
    const hard = req.query.hard === 'true';
    if (hard) {
      await Account.findByIdAndDelete(req.params.id);
      await Vault.deleteSession(req.params.id);
      logger.info(`[Account] Deleted permanently: ${req.params.id}`);
    } else {
      await Account.findByIdAndUpdate(req.params.id, { isActive: false });
      await Vault.deleteSession(req.params.id);
      logger.info(`[Account] Hidden: ${req.params.id}`);
    }
    res.json({ success: true });
  },

  async checkSession(req, res) {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const result = await AuthSvc.checkHealth(account);
    res.json(result);
  },

  async login(req, res) {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await AuthSvc.ensureSession(account);
    res.json({ success: true, status: account.status });
  },

  async syncProfile(req, res) {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const profile = await ActionSvc.syncProfile(account);
    res.json({ profile });
  },

  async updateProfile(req, res) {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const result = await ActionSvc.updateProfile(account, req.body);
    res.json(result);
  },

  async suggestBio(req, res) {
    const account = await Account.findById(req.params.id).select('-credentials').lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const result = await AISvc.suggestBio({
      niche:    account.niche    || req.body.niche    || 'general',
      name:     account.profile?.displayName || account.username,
      keywords: req.body.keywords || [],
    });
    res.json(result);
  },

  async stats(req, res) {
    const [total, byStatus, byRole] = await Promise.all([
      Account.countDocuments({ isActive: true }),
      Account.aggregate([{ $match: { isActive:true } }, { $group: { _id:'$status', count:{ $sum:1 } } }]),
      Account.aggregate([{ $match: { isActive:true } }, { $group: { _id:'$role',   count:{ $sum:1 } } }]),
    ]);
    res.json({
      total,
      byStatus: byStatus.reduce((a,s)=>{ a[s._id]=s.count; return a; }, {}),
      byRole:   byRole.reduce((a,r)=>{ a[r._id]=r.count; return a; }, {}),
    });
  },

  // ── رفع الصور ──────────────────────────────────────────────────
  async bulkCheck(req, res) {
    const { accountIds, batchSize = 1 } = req.body;
    const query = accountIds?.length ? { _id: { $in: accountIds }, isActive: true } : { isActive: true };
    const accounts = await Account.find(query);
    if (!accounts.length) return res.json({ total: 0 });

    const queue = getQueue(QUEUE_NAMES.HEALTH_CHECK);
    const parentJobId = `health-check-${Date.now()}`;
    await queue.addBulk(accounts.map((account, idx) => ({
      name: QUEUE_NAMES.HEALTH_CHECK,
      data: { accountId: account._id.toString(), meta: { parentJobId, index: idx, total: accounts.length } },
      opts: { delay: idx * 8000, jobId: `hc-${account._id}-${Date.now()}` },
    })));
    logger.info(`[bulkCheck] Queued ${accounts.length} health checks → ${parentJobId}`);
    res.json({ started: true, total: accounts.length, jobId: parentJobId });
  },
  async bulkSyncProfiles(req, res) {
    const { accountIds, batchSize = 3 } = req.body;
    const query = accountIds?.length ? { _id: { $in: accountIds }, isActive: true } : { isActive: true, status: 'active' };
    const accounts = await Account.find(query);
    if (!accounts.length) return res.json({ total: 0 });

    const queue = getQueue(QUEUE_NAMES.PROFILE_SYNC);
    const parentJobId = `profile-sync-${Date.now()}`;
    await queue.addBulk(accounts.map((account, idx) => ({
      name: QUEUE_NAMES.PROFILE_SYNC,
      data: { accountId: account._id.toString(), meta: { parentJobId, index: idx, total: accounts.length } },
      opts: { delay: Math.floor(idx / batchSize) * 8000, jobId: `sync-${account._id}-${Date.now()}` },
    })));
    logger.info(`[bulkSyncProfiles] Queued ${accounts.length} sync jobs → ${parentJobId}`);
    res.json({ started: true, total: accounts.length, jobId: parentJobId });
  },
  async bulkUpdateProfiles(req, res) {
    const { accountIds, updates = {}, namesList = [], locationsList = [], useAI = false, niche, avatarPaths = [], bannerPaths = [], imageOrder = 'sequential', batchSize = 1 } = req.body;
    const query = accountIds?.length ? { _id: { $in: accountIds }, isActive: true } : { isActive: true, status: 'active' };
    const accounts = await Account.find(query);
    if (!accounts.length) return res.json({ message: 'No accounts found', total: 0 });

    const shuffled = arr => [...arr].sort(() => Math.random() - 0.5);
    const avatars = imageOrder === 'random' ? shuffled(avatarPaths) : avatarPaths;
    const banners = imageOrder === 'random' ? shuffled(bannerPaths) : bannerPaths;

    const queue = getQueue(QUEUE_NAMES.PROFILE_UPDATE);
    const parentJobId = `profile-update-${Date.now()}`;

    await queue.addBulk(accounts.map((account, idx) => {
      const jobUpdates = { ...updates };
      if (namesList.length)     jobUpdates.displayName = namesList[idx % namesList.length];
      if (locationsList.length) jobUpdates.location    = locationsList[idx % locationsList.length];
      if (avatars.length)       jobUpdates.avatarPath  = avatars[idx % avatars.length];
      if (banners.length)       jobUpdates.bannerPath  = banners[idx % banners.length];
      return {
        name: QUEUE_NAMES.PROFILE_UPDATE,
        data: { accountId: account._id.toString(), updates: jobUpdates, useAI, niche, meta: { parentJobId, index: idx, total: accounts.length } },
        opts: { delay: Math.floor(idx / batchSize) * 12000, jobId: `upd-${account._id}-${Date.now()}` },
      };
    }));

    logger.info(`[bulkUpdateProfiles] Queued ${accounts.length} update jobs → ${parentJobId}`);
    res.json({ started: true, total: accounts.length, jobId: parentJobId });
  },

  // ── Open browser for manual control ─────────────────────
  async openBrowser(req, res) {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const Browser = require('../services/browser.service');
    try {
      await Browser.openManualContext(account);
      res.json({ success: true, username: account.username,
        message: `افتح http://YOUR_SERVER_IP:6080/vnc.html لتشوف المتصفح` });
    } catch(e) {
      logger.error(`[ManualBrowser] Failed for @${account.username}: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  },

  async closeBrowser(req, res) {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const Browser = require('../services/browser.service');
    await Browser.closeManualContext().catch(() => {});
    res.json({ success: true });
  },

  async uploadImages(req, res) {
    try {
      const path  = require('path');
      const fs    = require('fs');
      const sharp = require('sharp').default || require('sharp');
      const uploadDir = path.join(process.cwd(), 'data', 'uploads');
      fs.mkdirSync(uploadDir, { recursive: true });

      const avatarPaths = [];
      const bannerPaths = [];

      for (const file of (req.files?.avatars || [])) {
        const fname = `avatar_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
        const fpath = path.join(uploadDir, fname);
        await sharp(file.buffer).resize(400, 400, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(fpath);
        avatarPaths.push(fpath);
      }
      for (const file of (req.files?.banners || [])) {
        const fname = `banner_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
        const fpath = path.join(uploadDir, fname);
        await sharp(file.buffer).resize(1500, 500, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(fpath);
        bannerPaths.push(fpath);
      }
      res.json({ avatarPaths, bannerPaths });
    } catch(e) {
      // fallback: save without processing
      const path = require('path');
      const fs   = require('fs');
      const uploadDir = path.join(process.cwd(), 'data', 'uploads');
      fs.mkdirSync(uploadDir, { recursive: true });
      const avatarPaths = [], bannerPaths = [];
      for (const file of (req.files?.avatars || [])) {
        const fpath = path.join(uploadDir, `avatar_${Date.now()}.jpg`);
        fs.writeFileSync(fpath, file.buffer);
        avatarPaths.push(fpath);
      }
      for (const file of (req.files?.banners || [])) {
        const fpath = path.join(uploadDir, `banner_${Date.now()}.jpg`);
        fs.writeFileSync(fpath, file.buffer);
        bannerPaths.push(fpath);
      }
      res.json({ avatarPaths, bannerPaths });
    }
  },


};

module.exports = AccountCtrl;