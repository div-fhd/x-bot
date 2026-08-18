'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const ActionSvc  = require('../../services/action.service');
const AISvc      = require('../../services/ai.service');
const Browser    = require('../../services/browser.service');
const { jobEvents } = require('../events/job.events');
const logger     = require('../../utils/logger');

module.exports = wrapProcessor(async function profileUpdateProcessor(job, { isCancelled }) {
  const { accountId, updates, useAI, niche, meta } = job.data;
  const account = await Account.findById(accountId);
  if (!account?.isActive) throw new Error(`SKIP: @${account?.username} — inactive`);
  await job.updateProgress(10);
  try {
    jobEvents.updateProg({ username: account.username, done: meta.index, total: meta.total, stage: 'processing' });
    let finalUpdates = { ...updates };
    if (useAI) {
      const s = await AISvc.suggestBio({ niche: niche || account.niche || 'general', name: account.profile?.displayName || account.username });
      if (s?.bio) finalUpdates.bio = s.bio;
    }
    await ActionSvc.updateProfile(account, finalUpdates, { isCancelled });
    const syncedProfile = await ActionSvc.syncProfile(account).catch(error => {
      logger.warn(`[ProfileUpdate] @${account.username}: saved, but profile refresh failed: ${error.message}`);
      return account.profile;
    });
    await job.updateProgress(100);
    jobEvents.updateProg({ username: account.username, done: meta.index + 1, total: meta.total, stage: 'completed', success: true, profile: syncedProfile });
    return { success: true };
  } catch(e) {
    const error = isCancelled()
      ? new Error(`CANCELLED:@${account.username} — profile update stopped by user`)
      : e;
    logger.warn(`[ProfileUpdate] @${account.username}: ${error.message}`);
    jobEvents.updateProg({ username: account.username, done: meta.index + 1, total: meta.total, stage: 'completed', error: error.message });
    throw error;
  }
}
);
