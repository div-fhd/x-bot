'use strict';
const cron   = require('node-cron');
const { Content, Schedule } = require('../models/index');
const { getQueue, QUEUE_NAMES } = require('../queues/queues');
const logger = require('../utils/logger');

let task = null;

// يفحص كل دقيقة عن تغريدات مجدولة حان وقتها ويصفّها للنشر.
// jobId ثابت لكل محتوى → BullMQ يمنع الازدواج أثناء وجود job معلّق/نشط.
async function tick() {
  try {
    // A process crash after claiming a job must not leave it looking active
    // forever or retry it blindly (the click may already have reached X).
    const staleCutoff = new Date(Date.now() - 15 * 60_000);
    const stale = await Schedule.find({ status:'running', updatedAt:{ $lt:staleCutoff } }).select('content').lean();
    if (stale.length) {
      const contentIds = stale.map(item => item.content).filter(Boolean);
      await Schedule.updateMany(
        { status:'running', updatedAt:{ $lt:staleCutoff } },
        { $set:{ status:'failed', note:'انقطع التنفيذ قبل تأكيد نتيجة النشر' } },
      );
      await Content.updateMany(
        { _id:{ $in:contentIds }, status:'قيد_النشر' },
        { $set:{ status:'فشل', failReason:'انقطع التنفيذ قبل تأكيد نتيجة النشر — تحقق من الحساب قبل إعادة المحاولة' } },
      );
      logger.warn(`[Scheduler] marked ${stale.length} stale running posts as failed (manual verification required)`);
    }

    const due = await Content.find({
      status: 'مجدول',
      scheduledAt: { $lte: new Date() },
    }).limit(100).lean();
    if (!due.length) return;

    const queue = getQueue(QUEUE_NAMES.SCHEDULED_POST);
    for (const c of due) {
      const schedule = await Schedule.findOne({ content:c._id, status:'pending' }).lean();
      // A running/done/failed schedule has already been claimed. Do not create
      // another BullMQ job merely because the content write is still pending.
      if (!schedule) continue;
      const meta = schedule?.requestId ? {
        parentJobId: schedule.requestId,
        maxConcurrency: schedule.maxConcurrency || 1,
      } : null;
      await queue.add(
        QUEUE_NAMES.SCHEDULED_POST,
        { accountId: String(c.account), contentId: String(c._id), ...(meta ? { meta } : {}) },
        { jobId: `schedpost-${c._id}`, attempts: 2, backoff: { type: 'fixed', delay: 30_000 },
          removeOnComplete: true, removeOnFail: 100 },
      );
    }
    logger.info(`[Scheduler] صفّ ${due.length} تغريدة مجدولة حان وقتها`);
  } catch (e) {
    logger.warn(`[Scheduler] tick error: ${e.message}`);
  }
}

function startScheduler() {
  if (task) return;
  task = cron.schedule('* * * * *', tick); // كل دقيقة
  logger.info('[Scheduler] بدأ — يفحص النشر المجدول كل دقيقة');
}

function stopScheduler() {
  if (task) { task.stop(); task = null; }
}

module.exports = { startScheduler, stopScheduler, tick };
