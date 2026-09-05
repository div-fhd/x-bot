'use strict';
const router = require('express').Router();
const ctrl   = require('../controllers/account.controller');
const { authMiddleware } = require('../middleware/index');
router.use(authMiddleware);

// ── Static routes أولاً (قبل /:id) ─────────────────────────
router.get   ('/',                     ctrl.list);
router.get   ('/stats',                ctrl.stats);
router.post  ('/',                     ctrl.create);
router.post  ('/bulk-import',          ctrl.bulkImport);
router.post  ('/bulk-check',           ctrl.bulkCheck);
router.post  ('/bulk-sync-profiles',   ctrl.bulkSyncProfiles);
router.post  ('/bulk-update-profiles', ctrl.bulkUpdateProfiles);
router.delete('/bulk',                 ctrl.bulkRemove);

const multer = require('multer');
// Profile batches can target hundreds of accounts. Keep the upload limit aligned
// with that workflow instead of rejecting the request at Multer's old 50-file cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 500 },
});
router.post  ('/upload-images', upload.fields([{ name:'avatars', maxCount:250 }, { name:'banners', maxCount:250 }]), ctrl.uploadImages);

// ── Dynamic routes /:id بعدها ───────────────────────────────
router.get   ('/:id',                  ctrl.get);
router.get   ('/:id/avatar',           ctrl.avatar);
router.patch ('/:id',                  ctrl.update);
router.patch ('/:id/credentials',      ctrl.updateCredentials);
router.delete('/:id',                  ctrl.remove);
router.post  ('/:id/check',            ctrl.checkSession);
router.post  ('/:id/open-browser',     ctrl.openBrowser);
router.post  ('/:id/close-browser',    ctrl.closeBrowser);
router.post  ('/:id/login',            ctrl.login);
router.post  ('/:id/sync-profile',     ctrl.syncProfile);
router.post  ('/:id/update-profile',   ctrl.updateProfile);
router.post  ('/:id/suggest-bio',      ctrl.suggestBio);

module.exports = router;
