'use strict';
const { registry, cancelTokens } = require('../../ops/operations.registry');
const { browserRegistry }        = require('../../ops/browser.registry');
const Browser                    = require('../../services/browser.service');
const AccountHealth              = require('../../ops/account-health');
const logger                     = require('../../utils/logger');

// طوابير تدير حالة الحساب بنفسها — لا نتدخّل بالتصنيف التلقائي فيها
const SELF_MANAGED = /health-check|profile-sync|profile-update/;

// BullMQ's worker concurrency is global. Operations that expose a batch size
// need their own gate; a delayed start alone does not prevent long jobs from
// overlapping once the next delayed job becomes active.
const OPERATION_GATES = new Map();

async function acquireOperationSlot(key, rawLimit) {
  const limit = Math.max(1, Number.parseInt(rawLimit, 10) || 1);
  let gate = OPERATION_GATES.get(key);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    OPERATION_GATES.set(key, gate);
  }

  if (gate.active >= limit) {
    await new Promise(resolve => gate.waiters.push(resolve));
  }
  gate.active++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.active = Math.max(0, gate.active - 1);
    const next = gate.waiters.shift();
    if (next) next();
    else if (gate.active === 0) OPERATION_GATES.delete(key);
  };
}

// opts.managesOwnBrowser = true → الـ processor يغلق الـ browser بنفسه (مثل engagement)
function wrapProcessor(processorFn, opts = {}) {
  return async function wrappedProcessor(job) {
    const { meta, accountId } = job.data;
    const parentJobId = meta?.parentJobId;
    const username    = job.data.username || accountId;
    let releaseOperationSlot = null;

    // ── Cancel check قبل البدء ──────────────────────────────
    if (parentJobId && cancelTokens.has(parentJobId)) {
      logger.warn(`[Processor] SKIP — op ${parentJobId} cancelled before start`);
      if (parentJobId) registry.jobDone(parentJobId, job.id, { username, success: false, skipped: true });
      return { skipped: true, reason: 'cancelled' };
    }

    if (parentJobId && meta?.maxConcurrency) {
      releaseOperationSlot = await acquireOperationSlot(parentJobId, meta.maxConcurrency);
      // The operation may have been cancelled while this job waited for a slot.
      if (cancelTokens.has(parentJobId)) {
        releaseOperationSlot();
        releaseOperationSlot = null;
        registry.jobDone(parentJobId, job.id, { username, success: false, skipped: true });
        return { skipped: true, reason: 'cancelled' };
      }
    }

    if (parentJobId) registry.jobStarted(parentJobId, job.id, username);
    if (accountId) {
      browserRegistry.track(accountId, username, {
        operationType: job.name,
        parentJobId,
      });
      browserRegistry.setBusy(accountId, job.name);
    }

    let success = false, skipped = false, errorMsg = null;
    try {
      const result = await processorFn(job, {
        isCancelled: () => parentJobId ? cancelTokens.has(parentJobId) : false,
      });
      success = true;
      return result;
    } catch(e) {
      skipped  = e.message?.startsWith('SKIP:') || e.message?.startsWith('CANCELLED:');
      errorMsg = e.message;
      if (!skipped) throw e;
    } finally {
      if (parentJobId) registry.jobDone(parentJobId, job.id, { username, success: success || skipped, skipped, error: errorMsg });
      // لو الـ processor يدير الـ browser بنفسه — لا تغلقه هنا
      if (!opts.managesOwnBrowser) {
        if (accountId) await Browser.closeContext(accountId).catch(() => {});
        if (accountId) browserRegistry.close(accountId);
      }
      // ── تصنيف صحة الحساب تلقائياً (عدا الطوابير التي تدير حالتها بنفسها) ──
      if (accountId && !SELF_MANAGED.test(job.name || '')) {
        if (success)        AccountHealth.recordSuccess(accountId).catch(() => {});
        else if (errorMsg)  AccountHealth.recordFailure(accountId, errorMsg).catch(() => {});
      }
      releaseOperationSlot?.();
    }
  };
}

module.exports = { wrapProcessor };
