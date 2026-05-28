'use strict';
const { Queue }        = require('bullmq');
const { createConnection } = require('./connection');

// QUEUE_PREFIX يعزل queues كل instance عن الثاني لو شاركا نفس الـ Redis
const PREFIX = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : 'xops-';

const QUEUE_NAMES = {
  FOLLOW:         `${PREFIX}follow`,
  LIKE:           `${PREFIX}like`,
  RETWEET:        `${PREFIX}retweet`,
  TWEET_MULTI:    `${PREFIX}tweet-multi`,
  MUTUAL_FOLLOW:  `${PREFIX}mutual-follow`,
  REPORT_ACCOUNT: `${PREFIX}report-account`,
  REPORT_TWEET:   `${PREFIX}report-tweet`,
  PROFILE_UPDATE: `${PREFIX}profile-update`,
  PROFILE_SYNC:   `${PREFIX}profile-sync`,
  HEALTH_CHECK:   `${PREFIX}health-check`,
  ENGAGEMENT:     `${PREFIX}engagement`,
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