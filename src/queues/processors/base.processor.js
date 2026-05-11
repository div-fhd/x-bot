'use strict';
const { registry, cancelTokens } = require('../../ops/operations.registry');
const { browserRegistry }        = require('../../ops/browser.registry');
const Browser                    = require('../../services/browser.service');
const logger                     = require('../../utils/logger');

function wrapProcessor(processorFn) {
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
        // helper يستخدمه الـ processor لكشف الإلغاء أثناء التنفيذ
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
      // إغلاق الـ browser context دائماً
      if (accountId) await Browser.closeContext(accountId).catch(() => {});
      if (accountId) browserRegistry.close(accountId);
    }
  };
}

module.exports = { wrapProcessor };
