'use strict';
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ── User ──────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role:         { type: String, enum: ['مدير', 'مشغل', 'مراقب'], default: 'مشغل' },
  isActive:     { type: Boolean, default: true },
}, { timestamps: true });
UserSchema.methods.checkPassword = function (p) { return bcrypt.compare(p, this.passwordHash); };
const User = mongoose.model('User', UserSchema);

// ── Content ───────────────────────────────────────────────────
const ContentSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  text:    { type: String, required: true, maxlength: 280 },
  mediaUrls: [String],
  status: {
    type: String,
    enum: ['مسودة','بانتظار_موافقة','معتمد','مجدول','منشور','فشل','ملغى'],
    default: 'مسودة', index: true,
  },
  scheduledAt:   { type: Date, index: true },
  publishedAt:   Date,
  tweetId:       String,
  tweetUrl:      String,
  failReason:    String,
  retryCount:    { type: Number, default: 0 },
  aiGenerated:   { type: Boolean, default: false },
  qualityScore:  { type: Number, min: 0, max: 10 },
  riskScore:     { type: Number, min: 0, max: 10 },
  aiSuggestion:  String,
  approvedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt:    Date,
  rejectionNote: String,
  niche:         String,
  tags:          [String],
  replyToTweetId:String,
}, { timestamps: true });
ContentSchema.index({ account:1, status:1, scheduledAt:1 });
const Content = mongoose.model('Content', ContentSchema);

// ── ActivityLog ───────────────────────────────────────────────
const LogSchema = new mongoose.Schema({
  account:    { type: mongoose.Schema.Types.ObjectId, ref: 'Account', index: true },
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  category:   { type: String, index: true },
  action:     { type: String, required: true },
  result:     { type: String, enum: ['success','failure','skipped'], default: 'success' },
  details:    mongoose.Schema.Types.Mixed,
  errorMsg:   String,
  durationMs: Number,
}, { timestamps: true });
LogSchema.index({ account:1, category:1, createdAt:-1 });
LogSchema.index({ createdAt:-1 });
const ActivityLog = mongoose.model('ActivityLog', LogSchema);

// ── RiskEvent ─────────────────────────────────────────────────
const RiskSchema = new mongoose.Schema({
  account:     { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  level:       { type: String, enum: ['low','medium','high','critical'], default: 'medium' },
  type:        String,
  description: { type: String, required: true },
  details:     mongoose.Schema.Types.Mixed,
  resolved:    { type: Boolean, default: false },
  resolvedAt:  Date,
  resolvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolution:  String,
}, { timestamps: true });
const RiskEvent = mongoose.model('RiskEvent', RiskSchema);

// ── Schedule ──────────────────────────────────────────────────
const ScheduleSchema = new mongoose.Schema({
  account:     { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  content:     { type: mongoose.Schema.Types.ObjectId, ref: 'Content' },
  type:        { type: String, enum: ['post','engage','check'], required: true },
  scheduledAt: { type: Date, required: true, index: true },
  status:      { type: String, enum: ['pending','done','failed','cancelled'], default: 'pending' },
  note:        String,
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
const Schedule = mongoose.model('Schedule', ScheduleSchema);

// ── EngageCampaign ────────────────────────────────────────────
// Stores a "engage this tweet with these accounts" campaign
const EngageCampaignSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  tweetUrl:    { type: String, required: true },
  tweetId:     { type: String },

  // Which accounts to use (can be filtered by role/tag)
  accountIds:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Account' }],
  accountRole: String,   // alternatively, select by role
  accountTags: [String], // or by tags

  // What to do
  actions: [{
    type: String,
    enum: ['like', 'retweet', 'reply', 'follow_author'],
  }],

  // Reply texts — rotated across accounts
  replyTexts: [String],

  // Counts per action
  targets: {
    likes:    { type: Number, default: 0 },
    retweets: { type: Number, default: 0 },
    replies:  { type: Number, default: 0 },
  },

  // Timing
  delayMinMs:  { type: Number, default: 5000 },
  delayMaxMs:  { type: Number, default: 15000 },
  scheduleAt:  Date,  // optional — run at specific time

  status:      { type: String, enum: ['draft','running','done','failed','cancelled'], default: 'draft' },
  results:     mongoose.Schema.Types.Mixed,
  startedAt:   Date,
  finishedAt:  Date,
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
const EngageCampaign = mongoose.model('EngageCampaign', EngageCampaignSchema);

// ── Logging helper ────────────────────────────────────────────
async function log(accountId, category, action, result = 'success', details = {}) {
  try {
    await ActivityLog.create({ account: accountId, category, action, result, details });
  } catch {}
}

module.exports = { User, Content, ActivityLog, RiskEvent, Schedule, EngageCampaign, log };
