'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const ActionSvc  = require('../../services/action.service');
const AISvc      = require('../../services/ai.service');
const Browser    = require('../../services/browser.service');
const { jobEvents } = require('../events/job.events');
const logger     = require('../../utils/logger');

module.exports = wrapProcessor(async function profileUpdateProcessor(job) {
  const { accountId, updates, useAI, niche, meta } = job.data;
  const account = await Account.findById(accountId);
  if (!account?.isActive) throw new Error(`SKIP: @${account?.username} — inactive`);
  await job.updateProgress(10);
  try {
    let finalUpdates = { ...updates };
    if (useAI) {
      const s = await AISvc.suggestBio({ niche: niche || account.niche || 'general', name: account.profile?.displayName || account.username });
      if (s?.bio) finalUpdates.bio = s.bio;
    }
    await ActionSvc.updateProfile(account, finalUpdates);
    await job.updateProgress(100);
    jobEvents.updateProg({ username: account.username, done: meta.index + 1, total: meta.total, success: true });
    return { success: true };
  } catch(e) {
    logger.warn(`[ProfileUpdate] @${account.username}: ${e.message}`);
    jobEvents.updateProg({ username: account.username, done: meta.index + 1, total: meta.total, error: e.message });
    throw e;
  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
}
);
