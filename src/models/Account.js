'use strict';
const mongoose = require('mongoose');
const cfg      = require('../config');

const AccountSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true, trim: true, index: true },
  label:     { type: String },
  niche:     { type: String },
  isPrimary: { type: Boolean, default: false },
  tags:      [String],
  ownedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Role: what is this account used for?
  role: {
    type: String,
    enum: ['post', 'engage', 'support', 'mixed'],
    default: 'mixed',
    index: true,
  },

  credentials: {
    passwordEnc:    { type: String, required: true },
    email:          { type: String },
    sessionTokenEnc:{ type: String },
    authTokenEnc:   { type: String },
    totpSecretEnc:  { type: String },
  },

  status: {
    type: String,
    enum: ['نشط', 'يحتاج_مصادقة', 'نقطة_تحقق', 'محظور', 'غير_نشط', 'موقوف'],
    default: 'غير_نشط',
    index: true,
  },
  statusNote:   { type: String },
  lastCheckedAt:{ type: Date },
  lastActiveAt: { type: Date },

  network: {
    proxyUrl:  String,
    userAgent: String,
    timezone:  { type: String, default: 'America/New_York' },
    locale:    { type: String, default: 'en-US' },
  },

  profile: {
    displayName:    String,
    bio:            String,
    location:       String,
    website:        String,
    followersCount: { type: Number, default: 0 },
    followingCount: { type: Number, default: 0 },
    tweetsCount:    { type: Number, default: 0 },
    avatarUrl:      String,
    lastSyncedAt:   Date,
  },

  dailyCaps: {
    follow: { type: Number, default: cfg.caps.follow },
    like:   { type: Number, default: cfg.caps.like   },
    reply:  { type: Number, default: cfg.caps.reply  },
    post:   { type: Number, default: cfg.caps.post   },
  },

  features: {
    follow: { type: Boolean, default: true },
    like:   { type: Boolean, default: true },
    repost: { type: Boolean, default: true },
    reply:  { type: Boolean, default: true },
    post:   { type: Boolean, default: true },
  },

  todayCounters: {
    date:    String,
    follows: { type: Number, default: 0 },
    likes:   { type: Number, default: 0 },
    replies: { type: Number, default: 0 },
    posts:   { type: Number, default: 0 },
    reposts: { type: Number, default: 0 },
  },

  notes:    String,
  isActive: { type: Boolean, default: true },

}, { timestamps: true, toJSON: { virtuals: true } });

AccountSchema.virtual('isOperational').get(function () {
  return this.status === 'نشط' && this.isActive;
});

AccountSchema.methods.canDo = function (action) {
  if (!this.isOperational) return false;
  if (this.features && this.features[action] === false) return false;
  const today = new Date().toISOString().slice(0, 10);
  const c     = this.todayCounters;
  if (!c || c.date !== today) return true;
  const caps   = { follow: this.dailyCaps.follow, like: this.dailyCaps.like, reply: this.dailyCaps.reply, post: this.dailyCaps.post, repost: this.dailyCaps.like };
  const counts = { follow: c.follows, like: c.likes, reply: c.replies, post: c.posts, repost: c.reposts };
  return (counts[action] || 0) < (caps[action] || 999);
};

AccountSchema.methods.bump = async function (action) {
  const today = new Date().toISOString().slice(0, 10);
  if (!this.todayCounters || this.todayCounters.date !== today) {
    this.todayCounters = { date: today, follows:0, likes:0, replies:0, posts:0, reposts:0 };
  }
  const m = { follow:'follows', like:'likes', reply:'replies', post:'posts', repost:'reposts' };
  if (m[action]) this.todayCounters[m[action]]++;
  return this.save();
};

AccountSchema.index({ status: 1, isActive: 1 });
AccountSchema.index({ role: 1 });

module.exports = mongoose.model('Account', AccountSchema);