'use strict';
const mongoose = require('mongoose');
const Account  = require('../models/Account');
const logger   = require('../utils/logger');

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

  // ── فحص بروكسي ────────────────────────────────────────────────
  async checkProxy(req, res) {
    const proxy = await Proxy.findById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'غير موجود' });
    try {
      const https = require('https');
      const { URL } = require('url');

      // تحليل الـ proxy URL يدوياً بدون مكتبة خارجية
      const pu = new URL(proxy.url);
      const isSOCKS = pu.protocol.startsWith('socks');

      if (isSOCKS) {
        // SOCKS — نستخدم https-proxy-agent إذا موجودة وإلا نرجع خطأ مفيد
        try {
          const { SocksProxyAgent } = require('socks-proxy-agent');
          const agent = new SocksProxyAgent(proxy.url);
          const ip = await new Promise((resolve, reject) => {
            const r = https.get('https://api.ipify.org', { agent, timeout: 10000 }, res2 => {
              let d = '';
              res2.on('data', ch => d += ch);
              res2.on('end', () => resolve(d.trim()));
            });
            r.on('error', reject);
            r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
          });
          return res.json({ ok: true, ip, type: 'socks' });
        } catch(e) {
          if (e.code === 'MODULE_NOT_FOUND') return res.json({ ok: false, error: 'SOCKS غير مدعوم — ثبّت socks-proxy-agent' });
          return res.json({ ok: false, error: e.message });
        }
      }

      // HTTP/HTTPS proxy — CONNECT tunnel
      const proxyAuth = pu.username
        ? Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`).toString('base64')
        : null;

      const ip = await new Promise((resolve, reject) => {
        const connectReq = require('http').request({
          host: pu.hostname,
          port: pu.port || 80,
          method: 'CONNECT',
          path: 'api.ipify.org:443',
          headers: {
            'Host': 'api.ipify.org:443',
            ...(proxyAuth ? { 'Proxy-Authorization': `Basic ${proxyAuth}` } : {}),
          },
          timeout: 10000,
        });
        connectReq.on('connect', (res2, socket) => {
          if (res2.statusCode !== 200) {
            socket.destroy();
            return reject(new Error(`Proxy CONNECT failed: ${res2.statusCode}`));
          }
          const tlsSocket = require('tls').connect({ host: 'api.ipify.org', socket, servername: 'api.ipify.org' }, () => {
            tlsSocket.write('GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
          });
          let data = '';
          tlsSocket.on('data', d => data += d);
          tlsSocket.on('end', () => {
            const body = data.split('\r\n\r\n')[1] || data;
            resolve(body.trim());
          });
          tlsSocket.on('error', reject);
        });
        connectReq.on('error', reject);
        connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('timeout')); });
        connectReq.end();
      });
      res.json({ ok: true, ip, type: 'http' });
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
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

  // ── فحص بروكسي ────────────────────────────────────────────────
  async checkProxy(req, res) {
    const proxy = await Proxy.findById(req.params.id);
    if (!proxy) return res.status(404).json({ error: 'غير موجود' });
    try {
      const https = require('https');
      const { URL } = require('url');
      const pu = new URL(proxy.url);
      // بناء tunnel يدوي عبر CONNECT — يعمل مع http/socks proxies بدون dependencies إضافية
      const http = require('http');
      const ip = await new Promise((resolve, reject) => {
        const connectReq = http.request({
          host: pu.hostname,
          port: pu.port || 80,
          method: 'CONNECT',
          path: 'api.ipify.org:443',
          headers: {
            'Host': 'api.ipify.org:443',
            ...(pu.username ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password)}`).toString('base64') } : {}),
          },
          timeout: 10000,
        });
        connectReq.on('connect', (res2, socket) => {
          const req2 = https.request({
            host: 'api.ipify.org',
            path: '/',
            method: 'GET',
            socket,
            agent: false,
          }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => resolve(d.trim()));
          });
          req2.on('error', reject);
          req2.end();
        });
        connectReq.on('error', reject);
        connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('timeout')); });
        connectReq.end();
      });
      res.json({ ok: true, ip });
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
  },

  // ── Bulk import proxies ───────────────────────────────────
  // ── Check proxy URL (no DB) ────────────────────────────────
  async checkUrl(req, res) {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const net = require('net');
    const start = Date.now();
    try {
      const pu   = new URL(url);
      const host = pu.hostname;
      const port = parseInt(pu.port) || 80;
      await new Promise((resolve, reject) => {
        const sock = net.createConnection({ host, port, timeout: 8000 });
        sock.on('connect', () => { sock.destroy(); resolve(); });
        sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
        sock.on('error', reject);
      });
      res.json({ ok: true, latency: Date.now() - start });
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
  },

  async bulkImport(req, res) {
    const { lines = [], autoAssign = false, assignTarget = 'no-proxy' } = req.body;
    if (!lines.length) return res.status(400).json({ error: 'No proxies provided' });

    const Proxy   = require('../models/index').Proxy;
    const Account = require('../models/Account');

    let added = 0, skipped = 0, failed = 0;
    const addedProxies = [];

    for (const { name, url } of lines) {
      try {
        const exists = await Proxy.findOne({ url });
        if (exists) { skipped++; addedProxies.push(exists); continue; }
        const proxy = await Proxy.create({ name, url });
        addedProxies.push(proxy);
        added++;
      } catch { failed++; }
    }

    // Auto-assign after import
    let assigned = 0;
    if (autoAssign && addedProxies.length) {
      const query = assignTarget === 'no-proxy'
        ? { 'network.proxyUrl': { $in: [null, undefined, ''] } }
        : assignTarget === 'active'
          ? { status: 'active' }
          : {};
      const accounts = await Account.find(query).lean();

      for (let i = 0; i < accounts.length; i++) {
        const proxy = addedProxies[i % addedProxies.length];
        await Account.updateOne(
          { _id: accounts[i]._id },
          { $set: { 'network.proxyUrl': proxy.url } }
        );
        assigned++;
      }
    }

    logger.info(`[Proxy] Bulk import: +${added} added, ${skipped} skipped, ${failed} failed${assigned ? `, ${assigned} assigned` : ''}`);
    res.json({ added, skipped, failed, assigned, total: lines.length });
  },

  // ── Bulk validate proxies ─────────────────────────────────
  async bulkValidate(req, res) {
    const { proxyIds = [] } = req.body;
    const Proxy = require('../models/index').Proxy;
    const net   = require('net');

    const proxies = proxyIds.length
      ? await Proxy.find({ _id: { $in: proxyIds } })
      : await Proxy.find();

    const results = await Promise.allSettled(proxies.map(async (proxy) => {
      const start = Date.now();
      try {
        const url  = new URL(proxy.url);
        const host = url.hostname;
        const port = parseInt(url.port) || 80;
        await new Promise((resolve, reject) => {
          const sock = net.createConnection({ host, port, timeout: 8000 });
          sock.on('connect', () => { sock.destroy(); resolve(); });
          sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
          sock.on('error', reject);
        });
        const latency = Date.now() - start;
        await Proxy.updateOne({ _id: proxy._id }, { $set: { status: 'active', latencyMs: latency, lastCheckedAt: new Date() } });
        return { id: proxy._id, ok: true, latency };
      } catch(e) {
        await Proxy.updateOne({ _id: proxy._id }, { $set: { status: 'dead', lastCheckedAt: new Date() } });
        return { id: proxy._id, ok: false, error: e.message };
      }
    }));

    const out = results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message });
    res.json({ results: out, healthy: out.filter(r=>r.ok).length, total: out.length });
  },

};