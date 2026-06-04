'use strict';
/**
 * Central X (Twitter) selector registry — LANGUAGE-INDEPENDENT.
 *
 * POLICY (غير قابل للتفاوض):
 *   1. data-testid هو المرتكز الأساسي — X يثبّته عبر كل لغات الواجهة.
 *   2. أدوار ARIA / الأنماط البنيوية كاحتياط.
 *   3. ممنوع نهائياً الاعتماد على النص الظاهر أو aria-label المترجم.
 *
 * كل عنصر = مصفوفة مرتّبة من البدائل (الأثبت أولاً). الـ resolver (./dom.js)
 * يجرّبها بالترتيب ويبلّغ بالضبط أي بدائل جُرّبت عند الفشل.
 *
 * lastVerified: 2026-06 — يُحدّث عند تغيّر X (اختبار الدخان ينبّه).
 */
module.exports = {
  // ── واجهة تسجيل الدخول / مؤشرات حالة الصفحة ──
  page: {
    loggedIn: [
      '[data-testid="SideNav_AccountSwitcher_Button"]',
      '[data-testid="AppTabBar_Home_Link"]',
      '[data-testid="primaryColumn"]',
    ],
    loginWall: [
      '[data-testid="loginButton"]',
      '[data-testid="LoginForm_Login_Button"]',
      'input[autocomplete="username"]',
    ],
  },

  // ── شريط أفعال التغريدة (في صفحة التغريدة) ──
  tweet: {
    // أيٌّ منها = الشريط رُسم فعلاً (الصفحة جاهزة، ليست فاضية/محدودة)
    actionBar:      ['[data-testid="like"]', '[data-testid="unlike"]', '[data-testid="retweet"]'],
    like:           ['[data-testid="like"]'],
    liked:          ['[data-testid="unlike"]'],       // الحالة الناتجة عن لايك ناجح
    retweet:        ['[data-testid="retweet"]'],
    retweeted:      ['[data-testid="unretweet"]'],
    retweetConfirm: ['[data-testid="retweetConfirm"]'],
    bookmark:       ['[data-testid="bookmark"]'],
    bookmarked:     ['[data-testid="removeBookmark"]'],
    reply:          ['[data-testid="reply"]'],
  },

  // ── صفحة البروفايل (للمتابعة) ──
  profile: {
    // أيٌّ منها = صفحة البروفايل رُسمت فعلاً
    ready:     ['[data-testid="userActions"]', '[data-testid="placementTracking"]', '[data-testid="UserName"]'],
    follow:    ['[data-testid$="-follow"]:not([data-testid$="-unfollow"])'],
    following: ['[data-testid$="-unfollow"]'],   // الحالة الناتجة عن متابعة ناجحة
  },

  // ── مُحرّر الكتابة (رد / اقتباس / تغريدة) ──
  compose: {
    editor:       ['[data-testid="tweetTextarea_0"]', 'div[role="textbox"][data-testid^="tweetTextarea"]'],
    submitInline: ['[data-testid="tweetButtonInline"]'],
    submit:       ['[data-testid="tweetButton"]'],
  },

  // ── طبقات/حوارات عامة (إغلاق لغة-محايد عبر testid، بلا نص) ──
  overlay: {
    sheetConfirm: ['[data-testid="confirmationSheetConfirm"]'],
    sheetCancel:  ['[data-testid="confirmationSheetCancel"]'],
    appBarClose:  ['[data-testid="app-bar-close"]'],
  },
};
