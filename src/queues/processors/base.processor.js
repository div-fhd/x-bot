'use strict';
const { registry }        = require('../../ops/operations.registry');
const { browserRegistry } = require('../../ops/browser.registry');

function wrapProcessor(processorFn) {
  return async function wrappedProcessor(job) {
    const { meta, accountId } = job.data;
    const parentJobId = meta?.parentJobId;
    const username    = job.data.username || accountId;
    if (parentJobId) registry.jobStarted(parentJobId, job.id, username);

    let success = false, skipped = false, errorMsg = null;
    try {
      const result = await processorFn(job);
      success = true;
      return result;
    } catch(e) {
      skipped  = e.message?.startsWith('SKIP:');
      errorMsg = e.message;
      if (!skipped) throw e;
    } finally {
      if (parentJobId) registry.jobDone(parentJobId, job.id, { username, success: success || skipped, skipped, error: errorMsg });
      if (accountId)  browserRegistry.close(accountId);
    }
  };
}

module.exports = { wrapProcessor };
