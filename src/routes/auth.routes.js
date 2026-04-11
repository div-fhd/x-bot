'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const cfg     = require('../config');
const { User } = require('../models/index');
const { authMiddleware } = require('../middleware/index');
const logger = require('../utils/logger');

// أول تسجيل (مدير)
router.post('/register', async (req, res) => {
  const count = await User.countDocuments();
  if (count > 0) return res.status(403).json({ error: 'التسجيل مغلق — تواصل مع المدير' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email و password مطلوبان' });
  const hash = await bcrypt.hash(password, 12);
  const user = await User.create({ email, passwordHash: hash, role: 'مدير' });
  const token = jwt.sign({ _id: user._id, email: user.email, role: user.role }, cfg.appSecret, { expiresIn: cfg.jwtExpires });
  res.status(201).json({ token, user: { id: user._id, email: user.email, role: user.role } });
});

// تسجيل دخول
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  // أولاً — جرب تسجيل الدخول المحلي (المدير)
  const user = await User.findOne({ email, isActive: true });
  if (user && await user.checkPassword(password)) {
    const token = jwt.sign({ _id: user._id, email: user.email, role: user.role }, cfg.appSecret, { expiresIn: cfg.jwtExpires });
    return res.json({ token, user: { id: user._id, email: user.email, role: user.role, name: user.name || 'مدير' } });
  }

  // ثانياً — جرب عبر سيرفر الأدمن (المشتركون)
  const adminServer = process.env.ADMIN_SERVER;
  if (adminServer) {
    try {
      const http  = adminServer.startsWith('https') ? require('https') : require('http');
      const body  = JSON.stringify({ email, password });
      const url   = new URL(adminServer + '/api/license/subscriber-login');
      const result = await new Promise((resolve, reject) => {
        const req2 = http.request({
          hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (r) => {
          let raw = '';
          r.on('data', c => raw += c);
          r.on('end', () => resolve({ status: r.statusCode, data: JSON.parse(raw) }));
        });
        req2.on('error', reject);
        req2.setTimeout(8000, () => { req2.destroy(); reject(new Error('timeout')); });
        req2.write(body); req2.end();
      });

      if (result.status === 200 && result.data.token) {
        // مشترك صالح — أنشئ token محلي بالصلاحيات
        // فك تشفير token الأدمن لاستخراج الـ _id الحقيقي
        const adminPayload = jwt.decode(result.data.token);
        const subscriberId = adminPayload?.id || adminPayload?._id || email;

        const token = jwt.sign({
          _id:         subscriberId,
          email,
          role:        'subscriber',
          name:        result.data.name,
          permissions: result.data.permissions,
          daysLeft:    result.data.daysLeft,
        }, cfg.appSecret, { expiresIn: '24h' });
        return res.json({
          token,
          user: { id: subscriberId, email, role: 'subscriber', name: result.data.name, daysLeft: result.data.daysLeft, permissions: result.data.permissions },
        });
      } else {
        return res.status(401).json({ error: result.data.error || 'بيانات الدخول غير صحيحة' });
      }
    } catch (e) {
      logger.warn(`[Auth] Admin server login failed: ${e.message}`);
    }
  }

  return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
});

// بيانات المستخدم الحالي
router.get('/me', authMiddleware, (req, res) => res.json({ user: req.user }));

module.exports = router;