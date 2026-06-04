'use strict';
const { registry, cancelTokens } = require('../../ops/operations.registry');
const { browserRegistry }        = require('../../ops/browser.registry');
const Browser                    = require('../../services/browser.service');
const AccountHealth              = require('../../ops/account-health');
const logger                     = require('../../utils/logger');

// طوابير تدير حالة الحساب بنفسها — لا نتدخّل بالتصنيف التلقائي فيها
const SELF_MANAGED = /health-check|profile-sync|profile-update/;

// opts.managesOwnBrowser = true → الـ processor يغلق الـ browser بنفسه (مثل engagement)
function wrapProcessor(processorFn, opts = {}) {
  return async function wrappedProcessor(job) {
    const { meta, accountId } = job.data;
    const parentJobId = meta?.parentJobId;
    const username    = job.data.username || accountId;

    // ── Cancel check قبل البدء ──────────────────────────────
    if (parentJobId && cancelTokens.has(parentJobId)) {
      logger.warn(`[Processor] SKIP — op ${parentJobId} cancelled before start`);
      if (parentJobId) registry.jobDone(parentJobId, job.id, { username, success: false, skipped: true });
      return { skipped: true, reason: 'cancelled' };
    }

    if (parentJobId) registry.jobStarted(parentJobId, job.id, username);

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
    }
  };
}

module.exports = { wrapProcessor };