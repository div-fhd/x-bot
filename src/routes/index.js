'use strict';
const express   = require('express');
const actCtrl   = require('../controllers/action.controller');
const cntCtrl   = require('../controllers/content.controller');
const dshCtrl   = require('../controllers/dashboard.controller');
const { authMiddleware } = require('../middleware/index');

// ── Actions ────────────────────────────────────────────────────
const actionRouter = express.Router();
actionRouter.use(authMiddleware);
actionRouter.post('/tweet',            actCtrl.tweet);
actionRouter.post('/tweet-multi',      actCtrl.tweetMulti);
actionRouter.post('/follow',           actCtrl.follow);
actionRouter.post('/like',             actCtrl.like);
actionRouter.post('/retweet',          actCtrl.retweet);
actionRouter.post('/reply',            actCtrl.reply);
actionRouter.post('/search',           actCtrl.search);
// AI
actionRouter.post('/suggest-tweets',   actCtrl.suggestTweets);
actionRouter.post('/suggest-replies',  actCtrl.suggestReplies);
actionRouter.post('/score-content',    actCtrl.scoreContent);
actionRouter.post('/analyze-risk',     actCtrl.analyzeRisk);
// Engagement campaigns
actionRouter.get ('/campaigns',        actCtrl.listCampaigns);
actionRouter.post('/campaigns',        actCtrl.createCampaign);
actionRouter.get ('/campaigns/:id',    actCtrl.getCampaign);
actionRouter.post('/campaigns/:id/run',actCtrl.runCampaign);
actionRouter.post('/campaigns/:id/cancel', actCtrl.cancelCampaign);

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
contentRouter.post  ('/schedule',                cntCtrl.schedule);
contentRouter.get   ('/schedules/list',          cntCtrl.listSchedules);
contentRouter.post  ('/schedules/:id/cancel',    cntCtrl.cancelSchedule);

// ── Dashboard ──────────────────────────────────────────────────
const dashRouter = express.Router();
dashRouter.use(authMiddleware);
dashRouter.get ('/overview',            dshCtrl.overview);
dashRouter.get ('/activity-chart',      dshCtrl.activityChart);
dashRouter.get ('/risks',               dshCtrl.risks);
dashRouter.post('/risks/:id/resolve',   dshCtrl.resolveRisk);
dashRouter.get ('/audit-log',           dshCtrl.auditLog);

module.exports = { actionRouter, contentRouter, dashRouter };
