'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const cfg     = require('../config');
const { User } = require('../models/index');
const { authMiddleware } = require('../middleware/index');

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
  const user = await User.findOne({ email, isActive: true });
  if (!user || !(await user.checkPassword(password))) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }
  const token = jwt.sign({ _id: user._id, email: user.email, role: user.role }, cfg.appSecret, { expiresIn: cfg.jwtExpires });
  res.json({ token, user: { id: user._id, email: user.email, role: user.role } });
});

// بيانات المستخدم الحالي
router.get('/me', authMiddleware, (req, res) => res.json({ user: req.user }));

module.exports = router;
