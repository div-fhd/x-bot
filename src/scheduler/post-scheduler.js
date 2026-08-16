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
    const due = await Content.find({
      status: 'مجدول',
      scheduledAt: { $lte: new Date() },
    }).limit(100).lean();
    if (!due.length) return;

    const queue = getQueue(QUEUE_NAMES.SCHEDULED_POST);
    for (const c of due) {
      const schedule = await Schedule.findOne({ content:c._id, status:'pending' }).lean();
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
