'use strict';
const jwt    = require('jsonwebtoken');
const cfg    = require('../config');
const logger = require('../utils/logger');

// ── التحقق من JWT ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'لا يوجد رمز مصادقة' });
  try {
    req.user = jwt.verify(token, cfg.appSecret);
    next();
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

module.exports = { authMiddleware, errorHandler };
