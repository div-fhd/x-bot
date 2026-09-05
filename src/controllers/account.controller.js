'use strict';
const mongoose = require('mongoose');
const Account  = require('../models/Account');
const { getQueue, QUEUE_NAMES } = require('../queues/queues');
const { Content, ActivityLog, RiskEvent, Schedule, EngageCampaign } = require('../models/index');
const Vault    = require('../services/vault.service');
const AuthSvc  = require('../services/auth.service');
const ActionSvc= require('../services/action.service');
const AISvc    = require('../services/ai.service');
const { parseBulkText } = require('../utils/parser');
const logger   = require('../utils/logger');
const { resetPreviousProfileJobs } = require('../services/profile-queue.service');
const cfg      = require('../config');

async function runPool(items, concurrency, handler) {
  let cursor = 0;
  const size = Math.max(1, Math.min(items.length, Number.parseInt(concurrency, 10) || 1));
  await Promise.all(Array.from({ length:size }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await handler(items[index], index);
    }
  }));
}

async function deleteAccountsPermanently(rawIds) {
  const ids = [...new Set(rawIds.map(String))].filter(id => mongoose.isValidObjectId(id));
  if (!ids.length) return { deleted:0, requested:0 };

  const accounts = await Account.find({ _id:{ $in:ids } }).select('_id username').lean();
  if (!accounts.length) return { deleted:0, requested:ids.length };
  const accountIds = accounts.map(account => account._id);

  const Browser = require('../services/browser.service');
  await Promise.allSettled(accounts.map(account => Browser.closeContext(String(account._id), { force:true })));
  await Promise.allSettled(accounts.map(account => Vault.deleteSession(String(account._id))));

  await Promise.all([
    Content.deleteMany({ account:{ $in:accountIds } }),
    ActivityLog.deleteMany({ account:{ $in:accountIds } }),
    RiskEvent.deleteMany({ account:{ $in:accountIds } }),
    Schedule.deleteMany({ account:{ $in:accountIds } }),
    EngageCampaign.updateMany(
      { accountIds:{ $in:accountIds } },
      { $pull:{ accountIds:{ $in:accountIds } } },
    ),
  ]);
  const result = await Account.deleteMany({ _id:{ $in:accountIds } });
  return { deleted:result.deletedCount, requested:ids.length, usernames:accounts.map(account => account.username) };
}

const AccountCtrl = {

  async list(req, res) {
    const { status, role, page = 1, limit = 50, q, isPrimary } = req.query;
    const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
    const requestedLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 50));
    const filter = { isActive: true };
    if (status)    filter.status    = status;
    if (role)      filter.role      = role;
    if (q)         filter.username  = { $regex: q, $options: 'i' };
    if (isPrimary) filter.isPrimary = true;
    // تطبيق حد عدد الحسابات للمشترك
    const maxAcc = req.user?.permissions?.maxAccounts;
    const effectiveLimit = maxAcc ? Math.min(requestedLimit, maxAcc) : requestedLimit;
    const [accounts, total] = await Promise.all([
      Account.find(filter).select('-credentials').sort({ createdAt: -1 })
        .skip((pageNumber-1)*effectiveLimit).limit(effectiveLimit).lean(),
      Account.countDocuments(filter),
    ]);
    const safeAccounts = accounts.map(account => {
      if (!account.profile) return account;
      const avatarStored = Boolean(account.profile.avatarLocalPath);
      const { avatarLocalPath, ...profile } = account.profile;
      return { ...account, profile:{ ...profile, avatarStored } };
    });
    res.json({ accounts:safeAccounts, total, page:pageNumber, limit:effectiveLimit, pages:Math.ceil(total/effectiveLimit) });
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
    if (a.profile) {
      a.profile.avatarStored = Boolean(a.profile.avatarLocalPath);
      delete a.profile.avatarLocalPath;
    }
    res.json(a);
  },

  async avatar(req, res) {
    const fs = require('fs');
    const path = require('path');
    const account = await Account.findById(req.params.id).select('profile.avatarLocalPath').lean();
    const storedPath = account?.profile?.avatarLocalPath;
    if (!storedPath) return res.status(404).json({ error:'لا توجد صورة محلية لهذا الحساب' });
    const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');
    const candidate = path.resolve(storedPath);
    if (candidate !== uploadsRoot && !candidate.startsWith(`${uploadsRoot}${path.sep}`)) {
      return res.status(403).json({ error:'مسار الصورة غير صالح' });
    }
    let realRoot, realFile;
    try {
      realRoot = fs.realpathSync(uploadsRoot);
      realFile = fs.realpathSync(candidate);
    } catch {
      return res.status(404).json({ error:'ملف الصورة غير موجود' });
    }
    if (!realFile.startsWith(`${realRoot}${path.sep}`) || !fs.statSync(realFile).isFile()) {
      return res.status(403).json({ error:'ملف الصورة غير صالح' });
    }
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(realFile);
  },

  async create(req, res) {
    const { username, password, email, session_token, auth_token, totp_secret,
            proxy_url, niche, label, tags, timezone, dailyCaps, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const handle = username.replace('@','').trim();
    const existing = await Account.findOne({ username:handle }).select('_id isActive').lean();
    if (existing?.isActive === false) {
      await deleteAccountsPermanently([existing._id]);
    } else if (existing) {
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

    // Deduplicate the payload before touching Mongo. For large imports this
    // prevents duplicate writes and unique-index races inside the same request.
    const uniqueByUsername = new Map();
    for (const row of valid) {
      const key = row.username.toLowerCase();
      if (uniqueByUsername.has(key)) results.skipped.push(row.username);
      uniqueByUsername.set(key, row);
    }
    const rows = [...uniqueByUsername.values()];
    let existingAccounts = await Account.find({ username: { $in: rows.map(row => row.username) } });
    const previouslyDeleted = existingAccounts.filter(account => account.isActive === false);
    if (previouslyDeleted.length) {
      await deleteAccountsPermanently(previouslyDeleted.map(account => account._id));
      existingAccounts = existingAccounts.filter(account => account.isActive !== false);
    }
    const existingByUsername = new Map(existingAccounts.map(account => [account.username.toLowerCase(), account]));
    const healthTargets = [];

    // The old implementation slept for 30-120 seconds inside the HTTP request.
    // A bounded DB pool imports 500 accounts quickly; browser checks are queued below.
    await runPool(rows, cfg.bulkImport.dbConcurrency, async row => {
      try {
        const existing = existingByUsername.get(row.username.toLowerCase());
        if (existing) {
          if (!updateExisting) { results.skipped.push(row.username); return; }
          existing.credentials = Vault.encryptAccount(row);
          if (row.proxy_url) existing.network = { ...existing.network, proxyUrl:row.proxy_url };
          if (defaultRole)  existing.role = defaultRole;
          if (defaultNiche) existing.niche = defaultNiche;
          await existing.save();
          results.updated.push(row.username);
          healthTargets.push({ _id:existing._id, username:existing.username });
          return;
        }

        const account = await Account.create({
          username: row.username,
          label:    `@${row.username}`,
          niche:    defaultNiche || '',
          role:     defaultRole  || 'mixed',
          credentials: Vault.encryptAccount(row),
          ownedBy: req.user._id,
          network: { proxyUrl:row.proxy_url || null, timezone:defaultTimezone || 'Asia/Riyadh' },
        });
        results.created.push(row.username);
        healthTargets.push({ _id:account._id, username:account.username });
      } catch (e) {
        results.errors.push({ username:row.username, error:e.message });
      }
    });

    let healthCheck = { queued:false, total:0, jobId:null };
    if (stagger !== 'manual' && healthTargets.length) {
      const queue = getQueue(QUEUE_NAMES.HEALTH_CHECK);
      const parentJobId = `health-check-import-${Date.now()}`;
      const concurrency = Math.max(1, Math.min(healthTargets.length, cfg.browser.limit, cfg.bulkImport.healthConcurrency));
      const { registry } = require('../ops/operations.registry');
      registry.create({
        parentJobId, type:'health-check', total:healthTargets.length,
        accountUsernames:healthTargets.map(account => account.username),
        meta:{ source:'bulk-import', maxConcurrency:concurrency },
      });
      try {
        await Promise.race([
          queue.waitUntilReady(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Queue connection timed out')), 8_000)),
        ]);
        const added = await queue.addBulk(healthTargets.map((account, index) => ({
          name: QUEUE_NAMES.HEALTH_CHECK,
          data: {
            accountId:String(account._id), username:account.username,
            meta:{ parentJobId, index, total:healthTargets.length, maxConcurrency:concurrency },
          },
          opts: {
            jobId:`import-hc-${parentJobId}-${account._id}`,
          },
        })));
        registry.registerJobs(parentJobId, added.map(job => job.id));
        healthCheck = {
          queued:true, total:healthTargets.length, jobId:parentJobId,
          concurrency, waves:Math.ceil(healthTargets.length / concurrency),
        };
      } catch (error) {
        registry.fail(parentJobId, error);
        healthCheck = { queued:false, total:healthTargets.length, jobId:parentJobId, error:error.message };
        logger.warn(`[Import] Accounts saved but health checks were not queued: ${error.message}`);
      }
    }

    logger.info(`[Import] created:${results.created.length} skipped:${results.skipped.length} errors:${results.errors.length}`);
    res.json({
      results,
      summary: { total, unique:rows.length, created:results.created.length, updated:results.updated.length, skipped:results.skipped.length, errors:results.errors.length },
      healthCheck,
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
      account.status     = 'auth_required';
      account.statusNote = 'Credentials updated';
    }
    await account.save();
    logger.info(`[Account] Credentials updated: @${account.username}`);
    res.json({ success: true });
  },

  async remove(req, res) {
    const result = await deleteAccountsPermanently([req.params.id]);
    if (!result.deleted) return res.status(404).json({ error:'Account not found' });
    logger.info(`[Account] Deleted permanently: @${result.usernames[0]}`);
    res.json({ success:true, deleted:result.deleted });
  },

  async bulkRemove(req, res) {
    const accountIds = Array.isArray(req.body.accountIds) ? req.body.accountIds.slice(0, 500) : [];
    if (!accountIds.length) return res.status(400).json({ error:'accountIds[] required' });
    const result = await deleteAccountsPermanently(accountIds);
    logger.info(`[Account] Permanently deleted ${result.deleted}/${result.requested} accounts`);
    res.json({ success:true, ...result });
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
    const { accountIds, batchSize = cfg.bulkImport.healthConcurrency } = req.body;
    const query = accountIds?.length ? { _id: { $in: accountIds }, isActive: true } : { isActive: true };
    const accounts = await Account.find(query);
    if (!accounts.length) return res.json({ total: 0 });

    const queue = getQueue(QUEUE_NAMES.HEALTH_CHECK);
    const parentJobId = `health-check-${Date.now()}`;
    const concurrency = Math.max(1, Math.min(accounts.length, cfg.browser.limit, Number.parseInt(batchSize, 10) || 1));
    const { registry } = require('../ops/operations.registry');
    registry.create({ parentJobId, type: 'health-check', total: accounts.length, accountUsernames: accounts.map(a => a.username), meta:{ maxConcurrency:concurrency } });
    let added;
    try {
      added = await queue.addBulk(accounts.map((account, idx) => ({
        name: QUEUE_NAMES.HEALTH_CHECK,
        data: { accountId: account._id.toString(), username:account.username, meta: { parentJobId, index: idx, total: accounts.length, maxConcurrency:concurrency } },
        opts: { jobId: `hc-${account._id}-${Date.now()}` },
      })));
    } catch (error) {
      registry.fail(parentJobId, error);
      throw error;
    }
    registry.registerJobs(parentJobId, added.map(j => j.id));
    logger.info(`[bulkCheck] Queued ${accounts.length} health checks → ${parentJobId}`);
    res.json({ started: true, total: accounts.length, jobId: parentJobId });
  },
  async bulkSyncProfiles(req, res) {
    const { accountIds, batchSize = 3 } = req.body;
    const { registry } = require('../ops/operations.registry');
    const runningSync = registry.getActive().find(operation => operation.type === 'profile-sync');
    if (runningSync) {
      return res.status(409).json({
        error: `توجد مزامنة بروفايلات جارية بالفعل (${runningSync.done}/${runningSync.total}). انتظر اكتمالها أو أوقفها من وحدة التحكم.`,
        jobId: runningSync.parentJobId,
      });
    }
    const query = accountIds?.length ? { _id: { $in: accountIds }, isActive: true } : { isActive: true, status: 'active' };
    const accounts = await Account.find(query);
    if (!accounts.length) return res.json({ total: 0 });

    const queue = getQueue(QUEUE_NAMES.PROFILE_SYNC);
    const parentJobId = `profile-sync-${Date.now()}`;
    const concurrency = Math.max(1, Math.min(Number.parseInt(batchSize, 10) || 1, cfg.browser.limit));
    registry.create({ parentJobId, type: 'profile-sync', total: accounts.length, accountUsernames: accounts.map(a => a.username), meta:{ maxConcurrency:concurrency } });
    let added;
    try {
      added = await queue.addBulk(accounts.map((account, idx) => ({
        name: QUEUE_NAMES.PROFILE_SYNC,
        data: { accountId: account._id.toString(), meta: { parentJobId, index: idx, total: accounts.length, maxConcurrency: concurrency } },
        opts: { jobId: `sync-${account._id}-${Date.now()}` },
      })));
    } catch (error) {
      registry.fail(parentJobId, error);
      throw error;
    }
    registry.registerJobs(parentJobId, added.map(j => j.id));
    logger.info(`[bulkSyncProfiles] Queued ${accounts.length} sync jobs → ${parentJobId}`);
    res.json({ started: true, total: accounts.length, jobId: parentJobId });
  },
  async bulkUpdateProfiles(req, res) {
    const {
      accountIds, updates = {}, namesList = [], locationsList = [], biosList = [],
      bioOrder = 'sequential', useAI = false, niche,
      avatarPaths = [], bannerPaths = [], imageOrder = 'sequential',
      avatarAssignments = {}, bannerAssignments = {}, batchSize = 1,
    } = req.body;
    logger.info(`[bulkUpdateProfiles] Request received: accounts=${accountIds?.length || 0}, avatars=${avatarPaths.length}, banners=${bannerPaths.length}`);
    const query = accountIds?.length ? { _id: { $in: accountIds }, isActive: true } : { isActive: true, status: 'active' };
    const foundAccounts = await Account.find(query);
    // MongoDB $in does not preserve the order selected in the UI. Keep that
    // order so sequential bios/images are assigned to the expected accounts.
    const accountMap = new Map(foundAccounts.map(account => [account._id.toString(), account]));
    const accounts = accountIds?.length
      ? accountIds.map(id => accountMap.get(String(id))).filter(Boolean)
      : foundAccounts;
    if (!accounts.length) return res.json({ message: 'No accounts found', total: 0 });

    const shuffled = arr => [...arr].sort(() => Math.random() - 0.5);
    const normalizedBios = biosList.map(bio => String(bio).trim()).filter(Boolean);
    if (normalizedBios.some(bio => bio.length > 160)) {
      return res.status(400).json({ error: 'Each bio must be 160 characters or fewer' });
    }
    const avatars = imageOrder === 'random' ? shuffled(avatarPaths) : avatarPaths;
    const banners = imageOrder === 'random' ? shuffled(bannerPaths) : bannerPaths;
    const bios = bioOrder === 'random' ? shuffled(normalizedBios) : normalizedBios;

    const queue = getQueue(QUEUE_NAMES.PROFILE_UPDATE);
    let workerCount = null;
    let clearedPrevious = null;
    try {
      await Promise.race([
        queue.waitUntilReady(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Queue connection timed out')), 8_000)),
      ]);
      clearedPrevious = await resetPreviousProfileJobs(queue, { reason:'new profile update' });
      workerCount = await Promise.race([
        queue.getWorkersCount(),
        new Promise(resolve => setTimeout(() => resolve(null), 5_000)),
      ]);
    } catch (error) {
      logger.error(`[bulkUpdateProfiles] Queue health check failed: ${error.message}`);
      return res.status(503).json({
        code: 'PROFILE_QUEUE_UNAVAILABLE',
        error: 'تعذر الاتصال بطابور تحديث الملفات الشخصية. أعد تشغيل السيرفر ثم حاول مجددًا.',
      });
    }
    if (workerCount === 0) {
      logger.error('[bulkUpdateProfiles] Rejected request: no profile-update worker is connected');
      return res.status(503).json({
        code: 'PROFILE_WORKER_UNAVAILABLE',
        error: 'عامل تحديث الملفات الشخصية غير متصل. أعد تشغيل السيرفر ثم حاول مجددًا.',
      });
    }
    if (workerCount === null) {
      // Worker startup is awaited before the HTTP server starts. A slow
      // getWorkersCount command must not leave an otherwise healthy request hanging.
      logger.warn('[bulkUpdateProfiles] Worker count check timed out; queue is ready, continuing');
    }
    const parentJobId = `profile-update-${Date.now()}`;
    const maxConcurrency = Math.max(1, Math.min(accounts.length, Number.parseInt(batchSize, 10) || 1));
    const { registry } = require('../ops/operations.registry');
    registry.create({
      parentJobId,
      type:             'profile-update',
      total:            accounts.length,
      accountUsernames: accounts.map(a => a.username),
      meta:             { maxConcurrency },
    });

    const jobs = accounts.map((account, idx) => {
      const jobUpdates = { ...updates };
      if (namesList.length)     jobUpdates.displayName = namesList[idx % namesList.length];
      if (locationsList.length) jobUpdates.location    = locationsList[idx % locationsList.length];
      if (bios.length)          jobUpdates.bio         = bios[idx % bios.length];
      const accountId = account._id.toString();
      if (avatarAssignments[accountId]) jobUpdates.avatarPath = avatarAssignments[accountId];
      else if (avatars.length) jobUpdates.avatarPath = avatars[imageOrder === 'same' ? 0 : idx % avatars.length];
      if (bannerAssignments[accountId]) jobUpdates.bannerPath = bannerAssignments[accountId];
      else if (banners.length) jobUpdates.bannerPath = banners[imageOrder === 'same' ? 0 : idx % banners.length];
      return {
        name: QUEUE_NAMES.PROFILE_UPDATE,
        data: {
          accountId: account._id.toString(), username: account.username, updates: jobUpdates, useAI, niche,
          meta: { parentJobId, index: idx, total: accounts.length, maxConcurrency },
        },
        opts: { jobId: `upd-${account._id}-${Date.now()}` },
      };
    });

    let added;
    try {
      added = await queue.addBulk(jobs);
    } catch (error) {
      registry.fail(parentJobId, error);
      throw error;
    }
    registry.registerJobs(parentJobId, added.map(j => j.id));

    logger.info(`[bulkUpdateProfiles] Queued ${accounts.length} update jobs → ${parentJobId} (workers: ${workerCount ?? 'ready'})`);
    res.json({
      started: true,
      total: accounts.length,
      jobId: parentJobId,
      clearedPrevious,
      operation: registry._snap(registry.get(parentJobId)),
    });
  },

  // ── Open browser for manual control ─────────────────────
  async openBrowser(req, res) {
    const account = await Account.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const Browser = require('../services/browser.service');
    try {
      await Browser.openManualContext(account);
      res.json({ success: true, username: account.username,
        message: `افتح http://${process.env.SERVER_IP || 'SERVER_IP'}:6080/vnc.html لتشوف المتصفح` });
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
      const sharp = require('sharp').default || require('sharp');
      const MediaLibrary = require('../services/media-library.service');
      const contentIndex = MediaLibrary.buildContentIndex();

      const avatarPaths = [];
      const bannerPaths = [];
      let reused = 0;

      for (const file of (req.files?.avatars || [])) {
        const fname = `avatar_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
        const buffer = await sharp(file.buffer).resize(400, 400, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
        const saved = MediaLibrary.saveUniqueBuffer({ bucket:'profiles', buffer, filename:fname, index:contentIndex });
        if (saved.reused) reused += 1;
        // Return one entry per selected file.  The same library file may be
        // deliberately assigned to more than one account after de-duplication.
        avatarPaths.push(saved.path);
      }
      for (const file of (req.files?.banners || [])) {
        const fname = `banner_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
        const buffer = await sharp(file.buffer).resize(1500, 500, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
        const saved = MediaLibrary.saveUniqueBuffer({ bucket:'profiles', buffer, filename:fname, index:contentIndex });
        if (saved.reused) reused += 1;
        bannerPaths.push(saved.path);
      }
      res.json({ avatarPaths, bannerPaths, reused });
    } catch(e) {
      // fallback: save without processing
      const MediaLibrary = require('../services/media-library.service');
      const contentIndex = MediaLibrary.buildContentIndex();
      const avatarPaths = [], bannerPaths = [];
      let reused = 0;
      for (const file of (req.files?.avatars || [])) {
        const saved = MediaLibrary.saveUniqueBuffer({ bucket:'profiles', buffer:file.buffer, filename:`avatar_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`, index:contentIndex });
        if (saved.reused) reused += 1;
        avatarPaths.push(saved.path);
      }
      for (const file of (req.files?.banners || [])) {
        const saved = MediaLibrary.saveUniqueBuffer({ bucket:'profiles', buffer:file.buffer, filename:`banner_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`, index:contentIndex });
        if (saved.reused) reused += 1;
        bannerPaths.push(saved.path);
      }
      res.json({ avatarPaths, bannerPaths, reused });
    }
  },


};

module.exports = AccountCtrl;
