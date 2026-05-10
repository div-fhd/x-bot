'use strict';
const { wrapProcessor } = require('./base.processor');
const Account    = require('../../models/Account');
const { Content } = require('../../models/index');
const ActionSvc  = require('../../services/action.service');
const Browser    = require('../../services/browser.service');
const AISvc      = require('../../services/ai.service');
const { jobEvents } = require('../events/job.events');
const logger     = require('../../utils/logger');

module.exports = wrapProcessor(async function tweetMultiProcessor(job) {
  const { accountId, mode, text, topic, hashtags, manualTexts, mediaPaths, meta } = job.data;
  const account = await Account.findById(accountId);
  if (!account?.isActive) throw new Error(`SKIP: @${account?.username} — inactive`);
  await job.updateProgress(10);
  try {
    let finalText = text;
    if (mode === 'ai') {
      const s = await AISvc.suggestTweets({ account, topic, hashtags, count: 1 });
      finalText = s?.[0]?.text || topic;
    } else if (mode === 'manual') {
      finalText = (manualTexts || [])[meta.index % (manualTexts?.length || 1)] || text;
    }
    const r = await ActionSvc.tweet(account, { text: finalText, mediaLocalPaths: mediaPaths || [] });
    await Content.create({ account: account._id, text: finalText, status: 'published', publishedAt: new Date(), tweetId: r.tweetId });
    await job.updateProgress(100);
    jobEvents.tweetProg({ username: account.username, done: meta.index + 1, total: meta.total, success: true, tweetId: r.tweetId });
    return { success: true, tweetId: r.tweetId };
  } catch(e) {
    jobEvents.tweetProg({ username: account.username, done: meta.index + 1, total: meta.total, success: false, error: e.message });
    throw e;
  } finally {
    await Browser.closeContext(accountId).catch(() => {});
  }
}
);
