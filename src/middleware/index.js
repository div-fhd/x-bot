'use strict';
const jwt    = require('jsonwebtoken');
const cfg    = require('../config');
const logger = require('../utils/logger');

// ── التحقق من JWT ─────────────────────────────────────────────
// cache حالة المشتركين الموقوفين
const _suspendedCache = new Map();

async function checkSubscriberStatus(email) {
  const cached = _suspendedCache.get(email);
  if (cached && Date.now() - cached.ts < 60_000) return cached.valid; // cache دقيقة
  const adminServer = process.env.ADMIN_SERVER;
  if (!adminServer) return true;
  try {
    const url  = `${adminServer}/api/license/check-status?email=${encodeURIComponent(email)}`;
    const http = adminServer.startsWith('https') ? require('https') : require('http');
    const valid = await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw).active === true); } catch { resolve(true); }
        });
      });
      req.on('error', () => resolve(true));
      req.setTimeout(5000, () => { req.destroy(); resolve(true); });
    });
    _suspendedCache.set(email, { valid, ts: Date.now() });
    return valid;
  } catch { return true; }
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'لا يوجد رمز مصادقة' });
  try {
    req.user = jwt.verify(token, cfg.appSecret);
    // فحص حالة المشترك
    if (req.user.role === 'subscriber' && process.env.ADMIN_SERVER) {
      checkSubscriberStatus(req.user.email).then(valid => {
        if (!valid) {
          if (!res.headersSent) res.status(403).json({ error: 'تم إيقاف اشتراكك — تواصل مع المدير' });
        } else {
          next();
        }
      }).catch(() => next());
    } else {
      next();
    }
  } catch {
    return res.status(401).json({ error: 'رمز المصادقة غير صالح أو منتهي' });
  }
}

// ── معالج الأخطاء العام ───────────────────────────────────────
function errorHandler(err, req, res, next) {
  logger.error(`[خطأ] ${req.method} ${req.path}: ${err.message}`);
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'خطأ في البيانات', details: Object.values(err.errors).map(e => e.message) });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0];
    return res.status(409).json({ error: `قيمة مكررة: ${field}` });
  }
  if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'رمز غير صالح' });
  const status  = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'خطأ داخلي في الخادم';
  res.status(status).json({ error: message });
}

// ── License middleware ───────────────────────────────────────
const LicenseSvc = require('../services/license.service');

const requireFeature = (feature) => (req, res, next) => {
  // إذا المستخدم مشترك — تحقق من صلاحياته في الـ JWT
  if (req.user?.role === 'subscriber' && req.user?.permissions) {
    const p = req.user.permissions;
    const map = {
      ai:       p.aiEnabled,
      schedule: p.scheduleEnabled,
      report:   p.reportEnabled,
      profiles: p.profilesEnabled !== false,
      import:   p.bulkImport !== false,
    };
    if (map[feature] === false || map[feature] === undefined && ['ai','schedule','report'].includes(feature)) {
      return res.status(403).json({ error: `هذه الميزة غير متاحة في باقتك` });
    }
    return next();
  }
  // وضع standalone أو مدير — بدون قيود
  if (!LicenseSvc.can(feature)) {
    return res.status(403).json({ error: `هذه الميزة غير متاحة في باقتك — ${feature}` });
  }
  next();
};

const requireLicense = (req, res, next) => {
  if (!LicenseSvc.isValid()) {
    return res.status(403).json({ error: 'ترخيص غير صالح أو منتهي — تواصل مع المدير' });
  }
  next();
};

module.exports = { authMiddleware, errorHandler, requireFeature, requireLicense };