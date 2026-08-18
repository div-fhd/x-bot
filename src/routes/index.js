'use strict';
const express   = require('express');
const actCtrl   = require('../controllers/action.controller');
const cntCtrl   = require('../controllers/content.controller');
const dshCtrl   = require('../controllers/dashboard.controller');
const { authMiddleware, requireFeature } = require('../middleware/index');

// ── Actions ────────────────────────────────────────────────────
const actionRouter = express.Router();
actionRouter.use(authMiddleware);
const multerAction = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB لدعم الفيديو
actionRouter.get ('/jobs',              actCtrl.listJobs);
actionRouter.post('/jobs/cancel-all',    actCtrl.cancelAllJobs);
actionRouter.post('/jobs/:jobId/cancel', actCtrl.cancelJob);
actionRouter.post('/upload-media',     multerAction.fields([{ name:'images', maxCount:100 }, { name:'video', maxCount:1 }]), actCtrl.uploadMedia);
actionRouter.get ('/media-library',          actCtrl.listMediaLibrary);
actionRouter.get ('/media-library/:id/file', actCtrl.getMediaLibraryFile);
actionRouter.post('/tweet',            actCtrl.tweet);
actionRouter.post('/tweet-multi',      actCtrl.tweetMulti);
actionRouter.post('/report-account', requireFeature('report'),   actCtrl.reportAccount);
actionRouter.post('/report-tweet',   requireFeature('report'),     actCtrl.reportTweet);
actionRouter.post('/mutual-follow',    actCtrl.mutualFollow);
actionRouter.post('/follow-multi',     actCtrl.followMulti);
actionRouter.post('/like-multi',       actCtrl.likeMulti);
actionRouter.post('/retweet-multi',    actCtrl.retweetMulti);
actionRouter.post('/follow',           actCtrl.follow);
actionRouter.post('/like',             actCtrl.like);
actionRouter.post('/retweet',          actCtrl.retweet);
actionRouter.post('/reply',            actCtrl.reply);
actionRouter.post('/search',           actCtrl.search);
// AI
actionRouter.post('/suggest-tweets',   requireFeature('ai'), actCtrl.suggestTweets);
actionRouter.post('/suggest-replies',  requireFeature('ai'), actCtrl.suggestReplies);
actionRouter.post('/score-content',    actCtrl.scoreContent);
actionRouter.post('/analyze-risk',     actCtrl.analyzeRisk);
// ملاحظة: حملات التفاعل تُدار عبر /v1/engagement (engagement.controller)
// النظام القديم في action.controller أُزيل — كان runCampaign مكسوراً (توقيع engageTweet تغيّر لحساب واحد)

// ── Content ────────────────────────────────────────────────────
const contentRouter = express.Router();
contentRouter.use(authMiddleware);
contentRouter.get   ('/',                        cntCtrl.list);
contentRouter.post  ('/',                        cntCtrl.create);
contentRouter.patch ('/:id',                     cntCtrl.update);
contentRouter.post  ('/:id/approve',             cntCtrl.approve);
contentRouter.post  ('/:id/publish-now',         cntCtrl.publishNow);
contentRouter.post  ('/:id/cancel',              cntCtrl.cancel);
contentRouter.delete('/:id',                     cntCtrl.remove);
contentRouter.post  ('/schedule',  requireFeature('schedule'),                cntCtrl.schedule);
contentRouter.post  ('/schedule/bulk', requireFeature('schedule'),            cntCtrl.bulkSchedule);
contentRouter.get   ('/schedules/list',          cntCtrl.listSchedules);
contentRouter.post  ('/schedules/:id/cancel',    cntCtrl.cancelSchedule);
contentRouter.post  ('/schedules/:id/retry',     cntCtrl.retrySchedule);

// ── Dashboard ──────────────────────────────────────────────────
const dashRouter = express.Router();
dashRouter.use(authMiddleware);
dashRouter.get ('/overview',            dshCtrl.overview);
dashRouter.get ('/activity-chart',      dshCtrl.activityChart);
dashRouter.get ('/risks',               dshCtrl.risks);
dashRouter.post('/risks/:id/resolve',   dshCtrl.resolveRisk);
dashRouter.get ('/audit-log',           dshCtrl.auditLog);

// ── Proxy routes ─────────────────────────────────────────────
const proxyCtrl = require('../controllers/proxy.controller');
const proxyRouter = require('express').Router();
proxyRouter.use(authMiddleware);
proxyRouter.get   ('/',                proxyCtrl.list);
proxyRouter.post  ('/',                proxyCtrl.create);
proxyRouter.patch ('/:id',             proxyCtrl.update);
proxyRouter.delete('/:id',             proxyCtrl.remove);
proxyRouter.post  ('/assign',          proxyCtrl.assign);
proxyRouter.post  ('/auto-distribute', proxyCtrl.autoDistribute);
proxyRouter.post  ('/remove-from-accounts', proxyCtrl.removeFromAccounts);
proxyRouter.post  ('/:id/check',            proxyCtrl.checkProxy);
proxyRouter.post  ('/:id/check',           proxyCtrl.checkProxy);
proxyRouter.post  ('/check-url',            proxyCtrl.checkUrl);
proxyRouter.post  ('/bulk-import',         proxyCtrl.bulkImport);
proxyRouter.post  ('/bulk-validate',       proxyCtrl.bulkValidate);

// ── Operations Management ────────────────────────────────────
const opsCtrl   = require('../ops/ops.controller');
const opsRouter = require('express').Router();
opsRouter.get   ('/',                   opsCtrl.getActive);
opsRouter.get   ('/all',                opsCtrl.getAll);
opsRouter.get   ('/browsers',           opsCtrl.getBrowsers);
opsRouter.get   ('/queues',             opsCtrl.getQueues);
opsRouter.get   ('/queues/stats',       opsCtrl.getQueueStats);
opsRouter.get   ('/:id',                opsCtrl.getOne);
opsRouter.post  ('/:id/cancel',         opsCtrl.cancel);
opsRouter.post  ('/:id/pause',          opsCtrl.pause);
opsRouter.post  ('/:id/resume',         opsCtrl.resume);
opsRouter.post  ('/:id/retry',          opsCtrl.retry);
opsRouter.post  ('/:id/reprioritize',   opsCtrl.reprioritize);
opsRouter.post  ('/queues/:key/pause',  opsCtrl.pauseQueue);
opsRouter.post  ('/queues/:key/resume', opsCtrl.resumeQueue);
opsRouter.delete('/queues/:key/failed', opsCtrl.clearFailed);
opsRouter.post  ('/force-kill',          opsCtrl.forceKill);   // أوقف كل شيء فوراً

// ── Engagement Campaigns ─────────────────────────────────────
const engCtrl    = require('../controllers/engagement.controller');
const engRouter  = require('express').Router();
engRouter.get  ('/',           engCtrl.list);
engRouter.post ('/',           engCtrl.create);
engRouter.post ('/:id/launch', engCtrl.launch);
engRouter.post ('/:id/cancel', engCtrl.cancel);
engRouter.delete('/:id',       engCtrl.remove);

module.exports = { actionRouter, contentRouter, dashRouter, proxyRouter, opsRouter, engRouter };
