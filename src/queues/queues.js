'use strict';
const { Queue }        = require('bullmq');
const { createConnection } = require('./connection');

const QUEUE_NAMES = {
  FOLLOW:         'xops-follow',
  LIKE:           'xops-like',
  RETWEET:        'xops-retweet',
  TWEET_MULTI:    'xops-tweet-multi',
  MUTUAL_FOLLOW:  'xops-mutual-follow',
  REPORT_ACCOUNT: 'xops-report-account',
  REPORT_TWEET:   'xops-report-tweet',
  PROFILE_UPDATE: 'xops-profile-update',
  PROFILE_SYNC:   'xops-profile-sync',
  HEALTH_CHECK:   'xops-health-check',
};

const DEFAULT_JOB_OPTS = {
  attempts: 2,
  backoff:  { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000, age: 7200  },
  removeOnFail:     { count: 500,  age: 86400 },
};

const _queues = new Map();

function getQueue(name) {
  if (_queues.has(name)) return _queues.get(name);
  const q = new Queue(name, {
    connection:        createConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
  _queues.set(name, q);
  return q;
}

async function closeAllQueues() {
  for (const [, q] of _queues) await q.close().catch(() => {});
  _queues.clear();
}

module.exports = { QUEUE_NAMES, getQueue, closeAllQueues };
