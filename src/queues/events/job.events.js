'use strict';
let _io = null;
function setIO(io) { _io = io; }
function emit(event, data) { if (_io) _io.emit(event, data); }
const jobEvents = {
  progress  : (data) => emit('job:progress',   data),
  done      : (data) => emit('job:done',        data),
  cancelled : (data) => emit('job:cancelled',   data),
  tweetProg : (data) => emit('tweet:multi:progress', data),
  tweetDone : (data) => emit('tweet:multi:done',     data),
  syncProg  : (data) => emit('profile:sync:progress',   data),
  updateProg: (data) => emit('profile:update:progress', data),
  checkProg : (data) => emit('account:check:progress',  data),
  checkDone : (data) => emit('account:check:done',      data),
};
function attachQueueEvents(queueName) {
  const { QueueEvents } = require('bullmq');
  const { createConnection } = require('../connection');
  const qe = new QueueEvents(queueName, { connection: createConnection() });
  qe.on('failed', ({ jobId, failedReason }) => {
    if (failedReason?.includes('SKIP:')) return;
    jobEvents.progress({ jobId, success: false, error: failedReason });
  });
  return qe;
}
module.exports = { setIO, jobEvents, attachQueueEvents };
