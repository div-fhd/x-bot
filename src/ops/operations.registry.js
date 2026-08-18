'use strict';
const { EventEmitter } = require('events');
const logger = require('../utils/logger');

const OP_STATES = {
  WAITING: 'waiting', ACTIVE: 'active', PAUSED: 'paused',
  COMPLETING: 'completing', COMPLETED: 'completed',
  CANCELLING: 'cancelling', CANCELLED: 'cancelled',
  FAILED: 'failed', RETRYING: 'retrying',
};

// ── Cancel Tokens ────────────────────────────────────────────
// parentJobId يُضاف هنا عند الـ cancel → كل processor يتحقق قبل التنفيذ
const cancelTokens = new Set();

class OperationsRegistry extends EventEmitter {
  constructor() {
    super();
    this._ops      = new Map();
    this._jobIndex = new Map();
  }

  create({ parentJobId, type, total, accountUsernames = [], meta = {} }) {
    cancelTokens.delete(parentJobId);
    const op = {
      parentJobId, type, state: OP_STATES.WAITING,
      total, done: 0, success: 0, failed: 0, skipped: 0,
      accounts: accountUsernames, activeAccounts: [], bullJobIds: [],
      startedAt: new Date(), updatedAt: new Date(), completedAt: null, meta,
    };
    this._ops.set(parentJobId, op);
    this.emit('op:created', this._snap(op));
    logger.info(`[OpsRegistry] Created ${type} op ${parentJobId} (${total} jobs)`);
    return op;
  }

  registerJobs(parentJobId, bullJobIds) {
    const op = this._ops.get(parentJobId);
    if (!op) return;
    op.bullJobIds = bullJobIds;
    bullJobIds.forEach(id => this._jobIndex.set(String(id), parentJobId));
  }

  jobStarted(parentJobId, bullJobId, username) {
    const op = this._ops.get(parentJobId);
    if (!op) return;
    if (op.state === OP_STATES.WAITING) op.state = OP_STATES.ACTIVE;
    if (!op.activeAccounts.includes(username)) op.activeAccounts.push(username);
    op.updatedAt = new Date();
    this.emit('op:progress', this._snap(op));
  }

  jobDone(parentJobId, bullJobId, { username, success, skipped = false, error = null }) {
    const op = this._ops.get(parentJobId);
    if (!op) return;
    op.done++;
    if (skipped) op.skipped++;
    else if (success) op.success++;
    else op.failed++;
    op.activeAccounts = op.activeAccounts.filter(u => u !== username);
    op.updatedAt = new Date();
    if (op.done >= op.total && ![OP_STATES.CANCELLING, OP_STATES.CANCELLED].includes(op.state)) {
      op.state = OP_STATES.COMPLETED;
      op.completedAt = new Date();
    }
    this.emit('op:progress', this._snap(op));
    if (op.state === OP_STATES.COMPLETED) this.emit('op:completed', this._snap(op));
  }

  async cancel(parentJobId) {
    const op = this._ops.get(parentJobId);
    if (!op || op.state === OP_STATES.COMPLETED) return false;
    op.state = OP_STATES.CANCELLING;
    this.emit('op:cancelling', this._snap(op));

    // ① signal لكل processor نشط إن العملية ملغاة
    cancelTokens.add(parentJobId);

    try {
      const { getQueue } = require('../queues/queues');
      const qn = this._queueName(op.type);
      if (qn) {
        const queue = getQueue(qn);
        let cancelled = 0;
        for (const jid of op.bullJobIds) {
          const job = await queue.getJob(jid).catch(() => null);
          if (job) {
            const s = await job.getState();
            if (['waiting','delayed'].includes(s)) { await job.remove(); cancelled++; }
            // محاولة إيقاف الـ active jobs أيضاً
            if (s === 'active') { await job.discard().catch(() => {}); }
          }
        }
        logger.info(`[OpsRegistry] Cancelled ${cancelled} queued jobs for ${parentJobId}`);
      }
    } catch(e) { logger.warn(`[OpsRegistry] Cancel error: ${e.message}`); }

    // ② إغلاق كل browser contexts المرتبطة بهذه العملية
    try {
      const Browser = require('../services/browser.service');
      const accounts = op.activeAccounts || [];
      for (const username of accounts) {
        // closeContext يأخذ accountId — نحاول عبر الـ registry
        const { browserRegistry } = require('./browser.registry');
        const ctx = browserRegistry.getAll().find(c => c.username === username);
        if (ctx?.accountId) await Browser.closeContext(ctx.accountId, { force: true }).catch(() => {});
      }
    } catch(e) { logger.warn(`[OpsRegistry] Browser close error: ${e.message}`); }

    op.state = OP_STATES.CANCELLED;
    op.completedAt = new Date();
    this.emit('op:cancelled', this._snap(op));

    // أبقِ token الإلغاء حتى تنظيف العملية. بعض jobs تكون active داخل بوابة
    // التسلسل لأكثر من 30 ثانية، وحذفه مبكراً يسمح لها بالبدء بعد الإلغاء.
    return true;
  }

  fail(parentJobId, error) {
    const op = this._ops.get(parentJobId);
    if (!op) return false;
    op.state = OP_STATES.FAILED;
    op.failed = Math.max(op.failed, op.total - op.done);
    op.meta = { ...op.meta, error: error?.message || String(error || 'Queue error') };
    op.updatedAt = new Date();
    op.completedAt = new Date();
    this.emit('op:progress', this._snap(op));
    return true;
  }

  async pause(parentJobId) {
    const op = this._ops.get(parentJobId);
    if (!op || op.state !== OP_STATES.ACTIVE) return false;
    const { getQueue } = require('../queues/queues');
    const qn = this._queueName(op.type);
    if (qn) await getQueue(qn).pause();
    op.state = OP_STATES.PAUSED; op.updatedAt = new Date();
    this.emit('op:paused', this._snap(op));
    return true;
  }

  async resume(parentJobId) {
    const op = this._ops.get(parentJobId);
    if (!op || op.state !== OP_STATES.PAUSED) return false;
    const { getQueue } = require('../queues/queues');
    const qn = this._queueName(op.type);
    if (qn) await getQueue(qn).resume();
    op.state = OP_STATES.ACTIVE; op.updatedAt = new Date();
    this.emit('op:resumed', this._snap(op));
    return true;
  }

  async retryFailed(parentJobId) {
    const op = this._ops.get(parentJobId);
    if (!op) return 0;
    const { getQueue } = require('../queues/queues');
    const qn = this._queueName(op.type);
    if (!qn) return 0;
    const failed = await getQueue(qn).getFailed();
    let retried = 0;
    const ids = new Set(op.bullJobIds.map(String));
    for (const job of failed) { if (ids.has(String(job.id))) { await job.retry(); retried++; } }
    if (retried > 0) { op.state = OP_STATES.RETRYING; op.failed = Math.max(0, op.failed - retried); op.updatedAt = new Date(); this.emit('op:retrying', this._snap(op)); }
    return retried;
  }

  async reprioritize(parentJobId, priority = 1) {
    const op = this._ops.get(parentJobId);
    if (!op) return false;
    const { getQueue } = require('../queues/queues');
    const qn = this._queueName(op.type);
    if (!qn) return false;
    const queue = getQueue(qn);
    for (const jid of op.bullJobIds) {
      const job = await queue.getJob(jid).catch(() => null);
      if (job) { const s = await job.getState(); if (['waiting','delayed'].includes(s)) await job.changePriority({ priority }); }
    }
    return true;
  }

  get(id) { return this._ops.get(id); }
  getAll() { return [...this._ops.values()].map(op => this._snap(op)); }
  getActive() { return this.getAll().filter(op => [OP_STATES.ACTIVE, OP_STATES.WAITING, OP_STATES.PAUSED, OP_STATES.RETRYING, OP_STATES.CANCELLING].includes(op.state)); }

  _snap(op) {
    const elapsed = (Date.now() - op.startedAt) / 1000;
    const rate    = op.done / Math.max(elapsed, 1);
    return {
      ...op,
      duration:    op.completedAt ? Math.round((op.completedAt - op.startedAt) / 1000) : Math.round(elapsed),
      eta:         op.done > 0 && op.state !== OP_STATES.COMPLETED ? Math.round((op.total - op.done) / rate) : null,
      successRate: op.done > 0 ? Math.round((op.success / op.done) * 100) : null,
      pct:         Math.round((op.done / Math.max(op.total, 1)) * 100),
    };
  }

  _queueName(type) {
    const { QUEUE_NAMES } = require('../queues/queues');
    return { 'follow': QUEUE_NAMES.FOLLOW, 'like': QUEUE_NAMES.LIKE, 'retweet': QUEUE_NAMES.RETWEET, 'tweet-multi': QUEUE_NAMES.TWEET_MULTI, 'mutual-follow': QUEUE_NAMES.MUTUAL_FOLLOW, 'report-account': QUEUE_NAMES.REPORT_ACCOUNT, 'report-tweet': QUEUE_NAMES.REPORT_TWEET, 'profile-update': QUEUE_NAMES.PROFILE_UPDATE, 'profile-sync': QUEUE_NAMES.PROFILE_SYNC, 'health-check': QUEUE_NAMES.HEALTH_CHECK, 'engagement': QUEUE_NAMES.ENGAGEMENT }[type] || null;
  }

  gc() {
    const cutoff = Date.now() - 3_600_000;
    const terminal = new Set([OP_STATES.COMPLETED, OP_STATES.CANCELLED, OP_STATES.FAILED]);
    for (const [id, op] of this._ops) {
      if (terminal.has(op.state) && op.completedAt < cutoff) {
        this._ops.delete(id);
        cancelTokens.delete(id);
      }
    }
  }
}

const registry = new OperationsRegistry();
setInterval(() => registry.gc(), 1_800_000).unref();
module.exports = { registry, OP_STATES, cancelTokens };
