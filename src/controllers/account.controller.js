'use strict';
const Account  = require('../models/Account');
const { User, log } = require('../models/index');
const Vault    = require('../services/vault.service');
const AuthSvc  = require('../services/auth.service');
const ActionSvc= require('../services/action.service');
const AISvc    = require('../services/ai.service');
const { parseBulkText } = require('../utils/parser');
const logger   = require('../utils/logger');

const AccountCtrl = {

  async list(req, res) {
    const { status, role, page = 1, limit = 50, q } = req.query;
    const filter = { isActive: true };
    if (status) filter.status = status;
    if (role)   filter.role   = role;
    if (q)      filter.username = { $regex: q, $options: 'i' };
    const [accounts, total] = await Promise.all([
      Account.find(filter).select('-credentials').sort({ createdAt: -1 })
        .skip((page-1)*limit).limit(+limit).lean(),
      Account.countDocuments(filter),
    ]);
    res.json({ accounts, total, page: +page, pages: Math.ceil(total/limit) });
  },

  async get(req, res) {
    const a = await Account.findById(req.params.id).select('-credentials').lean();
    if (!a) return res.status(404).json({ error: 'Account not found' });
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
      network: { proxyUrl: proxy_url, timezone: timezone || 'America/New_York' },
      dailyCaps: dailyCaps || {},
    });
    logger.info(`[Account] Created: @${handle}`);
    res.status(201).json({ account: { ...account.toObject(), credentials: undefined } });
  },

  async bulkImport(req, res) {
    const { text, defaultNiche, defaultTimezone, defaultRole, stagger = 'staggered' } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const { valid, invalid, total } = parseBulkText(text);
    if (!valid.length) return res.status(400).json({ error: 'No valid accounts found', invalid, total });

    const results = { created: [], skipped: [], errors: [] };

    for (let i = 0; i < valid.length; i++) {
      const row = valid[i];
      try {
        if (await Account.exists({ username: row.username })) {
          results.skipped.push(row.username); continue;
        }
        const creds = Vault.encryptAccount(row);
        const account = await Account.create({
          username: row.username,
          label:    `@${row.username}`,
          niche:    defaultNiche || '',
          role:     defaultRole  || 'mixed',
          credentials: creds,
          ownedBy: req.user._id,
          network: { proxyUrl: row.proxy_url || null, timezone: defaultTimezone || 'America/New_York' },
        });

        // Staggered session check — do NOT open all browsers at once
        if (stagger !== 'manual') {
          const delayMs = stagger === 'safe' ? i * 120_000 : i * 30_000;
          setTimeout(async () => {
            try {
              const acc = await Account.findById(account._id);
              if (acc) await AuthSvc.checkHealth(acc);
            } catch (e) {
              logger.warn(`[Import] Health check @${row.username}: ${e.message}`);
            }
          }, delayMs + 3000);
        }

        results.created.push(row.username);
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
    const allowed = ['label','niche','tags','role','network','features','dailyCaps','notes','status'];
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
    await account.save();
    await Vault.deleteSession(account._id.toString()); // invalidate cached session
    account.status = 'يحتاج_مصادقة';
    account.statusNote = 'Credentials updated';
    await account.save();
    logger.info(`[Account] Credentials updated: @${account.username}`);
    res.json({ success: true });
  },

  async remove(req, res) {
    await Account.findByIdAndUpdate(req.params.id, { isActive: false });
    await Vault.deleteSession(req.params.id);
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

  async uploadImages(req, res) {
    const fs   = require('fs');
    const path = require('path');
    const dir  = path.join(process.cwd(), 'data', 'images');
    fs.mkdirSync(dir, { recursive: true });

    const avatarPaths = [];
    const bannerPaths = [];

    const files = req.files || {};
    for (const file of (files.avatars || [])) {
      const dest = path.join(dir, `avatar_${Date.now()}_${file.originalname}`);
      fs.writeFileSync(dest, file.buffer);
      avatarPaths.push(dest);
    }
    for (const file of (files.banners || [])) {
      const dest = path.join(dir, `banner_${Date.now()}_${file.originalname}`);
      fs.writeFileSync(dest, file.buffer);
      bannerPaths.push(dest);
    }
    res.json({ avatarPaths, bannerPaths });
  },

  async bulkSyncProfiles(req, res) {
    const { accountIds } = req.body;
    const query = accountIds?.length
      ? { _id: { $in: accountIds }, isActive: true }
      : { isActive: true, status: 'نشط' };
    const accounts = await Account.find(query);
    if (!accounts.length) return res.json({ message: 'لا توجد حسابات', total: 0 });
    res.json({ started: true, total: accounts.length });
    setImmediate(async () => {
      let done = 0;
      for (const account of accounts) {
        try {
          await ActionSvc.syncProfile(account);
          done++;
          if (global.io) global.io.emit('profile:sync:progress', { done, total: accounts.length, username: account.username, profile: account.profile });
        } catch (e) {
          done++;
          logger.warn(`[BulkSync] @${account.username}: ${e.message}`);
          if (global.io) global.io.emit('profile:sync:progress', { done, total: accounts.length, username: account.username, error: e.message });
        }
        if (done < accounts.length) await new Promise(r => setTimeout(r, 8000));
      }
      if (global.io) global.io.emit('profile:sync:done', { total: accounts.length, done });
    });
  },

  async bulkUpdateProfiles(req, res) {
    const { accountIds, updates = {}, namesList = [], locationsList = [], useAI = false, niche, avatarPaths = [], bannerPaths = [], imageOrder = 'sequential' } = req.body;
    const query = accountIds?.length
      ? { _id: { $in: accountIds }, isActive: true }
      : { isActive: true, status: 'نشط' };
    const accounts = await Account.find(query);
    if (!accounts.length) return res.json({ message: 'لا توجد حسابات', total: 0 });
    res.json({ started: true, total: accounts.length });
    setImmediate(async () => {
      let done = 0;
      const shuffled = arr => [...arr].sort(() => Math.random() - 0.5);
      const avatars = imageOrder === 'random' ? shuffled(avatarPaths) : avatarPaths;
      const banners = imageOrder === 'random' ? shuffled(bannerPaths) : bannerPaths;
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        try {
          let finalUpdates = { ...updates };
          // الاسم بالترتيب — إذا في قائمة أسماء تأخذ كل حساب اسمه
          if (namesList.length > 0)     finalUpdates.displayName = namesList[i % namesList.length];
          if (locationsList.length > 0) finalUpdates.location    = locationsList[i % locationsList.length];
          if (avatars.length > 0) finalUpdates.avatarPath = avatars[i % avatars.length];
          if (banners.length > 0) finalUpdates.bannerPath = banners[i % banners.length];
          if (useAI) {
            try {
              const s = await AISvc.suggestBio({ niche: niche || account.niche || 'general', name: account.profile?.displayName || account.username, keywords: [] });
              if (s?.bio) finalUpdates.bio = s.bio;
            } catch (e) { logger.warn(`[BulkUpdate] AI @${account.username}: ${e.message}`); }
          }
          await ActionSvc.updateProfile(account, finalUpdates);
          done++;
          if (global.io) global.io.emit('profile:update:progress', { done, total: accounts.length, username: account.username, success: true });
        } catch (e) {
          done++;
          logger.warn(`[BulkUpdate] @${account.username}: ${e.message}`);
          if (global.io) global.io.emit('profile:update:progress', { done, total: accounts.length, username: account.username, error: e.message });
        }
        if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 12000));
      }
      if (global.io) global.io.emit('profile:update:done', { total: accounts.length, done });
    });
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
};

module.exports = AccountCtrl; 