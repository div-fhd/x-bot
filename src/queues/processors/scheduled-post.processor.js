'use strict';
const { wrapProcessor } = require('./base.processor');
const Account   = require('../../models/Account');
const { Content, Schedule } = require('../../models/index');
const ActionSvc = require('../../services/action.service');
const { swallow } = require('../../utils/swallow');
const logger    = require('../../utils/logger');

// ينشر تغريدة مجدولة عند وقتها ويحدّث حالتها (والـ Schedule المرتبط).
module.exports = wrapProcessor(async function scheduledPostProcessor(job) {
  const { contentId } = job.data;
  const content = await Content.findById(contentId);
  if (!content) throw new Error(`SKIP: content ${contentId} not found`);
  if (content.status !== 'مجدول') throw new Error(`SKIP: content ${contentId} no longer scheduled (${content.status})`);

  const account = await Account.findById(content.account);
  if (!account?.isOperational) {
    content.status = 'فشل'; content.failReason = `الحساب غير نشط (${account?.status || 'مفقود'})`;
    await content.save().catch(swallow('sched:save', 'warn'));
    await Schedule.updateMany({ content: content._id, status: 'pending' }, { status: 'failed' }).catch(swallow('sched:schedUpd'));
    throw new Error(`SKIP: @${account?.username} — not operational`);
  }

  try {
    const r = await ActionSvc.tweet(account, { text: content.text, mediaLocalPaths: content.mediaLocalPaths || [] });
    content.status      = 'منشور';
    content.publishedAt = new Date();
    content.tweetId     = r.tweetId;
    content.tweetUrl    = r.tweetUrl;
    await content.save();
    await Schedule.updateMany({ content: content._id, status: 'pending' }, { status: 'done' }).catch(swallow('sched:schedUpd'));
    logger.info(`[ScheduledPost] @${account.username} نشر ${content._id} → ${r.tweetId}`);

    // ── تفاعل تلقائي بعد النشر (إن فُعِّل عند الجدولة) ──
    if (content.engage?.enabled && r.tweetId) {
      try {
        const { launchAutoEngage } = require('../../ops/auto-engage');
        const tUrl = r.tweetUrl || `https://x.com/${account.username}/status/${r.tweetId}`;
        await launchAutoEngage({
          tweetId: r.tweetId, tweetUrl: tUrl,
          actionGroups: content.engage.actionGroups,
          replyTexts:   content.engage.replyTexts,
          delayMinMs:   content.engage.delayMinMs,
          delayMaxMs:   content.engage.delayMaxMs,
          label: 'scheduled',
        });
      } catch(e) { logger.warn(`[ScheduledPost] auto-engage error: ${e.message}`); }
    }
    return { success: true, tweetId: r.tweetId };
  } catch (e) {
    // SKIP/cap لا تُعَدّ فشلاً نهائياً — تبقى مجدولة لإعادة المحاولة
    if (!e.message?.startsWith('SKIP:')) {
      content.status = 'فشل'; content.failReason = e.message;
      await content.save().catch(swallow('sched:save', 'warn'));
      await Schedule.updateMany({ content: content._id, status: 'pending' }, { status: 'failed' }).catch(swallow('sched:schedUpd'));
    }
    throw e;
  }
});
