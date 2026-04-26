'use strict';
const fs      = require('fs');
const Browser = require('./browser.service');
const AuthSvc = require('./auth.service');
const { log } = require('../models/index');
const logger  = require('../utils/logger');
const { sleep, randInt } = require('../utils/delay');

const SEL = {
  composeBtn:    '[data-testid="SideNav_NewTweet_Button"]',
  tweetBox:      '[data-testid="tweetTextarea_0"]',
  tweetBtnInline:'[data-testid="tweetButtonInline"]',
  tweetBtn:      '[data-testid="tweetButton"]',
  fileInput:     '[data-testid="fileInput"]',
  likeBtn:       '[data-testid="like"]',
  unlikeBtn:     '[data-testid="unlike"]',
  retweetBtn:    '[data-testid="retweet"]',
  retweetConfirm:'[data-testid="retweetConfirm"]',
  replyBtn:      '[data-testid="reply"]',
  followBtn:     '[data-testid^="follow"]',
  primaryCol:    '[data-testid="primaryColumn"]',
  displayNameInput: 'input[name="displayName"]',
  bioInput:      'textarea[name="description"]',
  locationInput: 'input[name="location"]',
  websiteInput:  'input[name="url"]',
  saveProfileBtn:'[data-testid="Profile_Save_Button"]',
  avatarInput:   'input[data-testid="fileInput"][accept*="image"]',
  avatarBtn:     '[data-testid="ProfileAvatarButton"]',
  bannerBtn:     '[data-testid="ProfileBannerButton"]',
};

// ── X API helper ─────────────────────────────────────────────
async function xApi(creds, method, path, body = null) {
  const https = require('https');
  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request({
      hostname: 'api.x.com',
      path,
      method,
      headers: {
        'Authorization':   `Bearer ${BEARER}`,
        'Cookie':          `auth_token=${creds.auth_token}; ct0=${creds.session_token}`,
        'x-csrf-token':    creds.session_token,
        'Content-Type':    'application/json',
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('API timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

const ActionSvc = {

  // ── Tweet ─────────────────────────────────────────────────────
  async tweet(account, content) {
    if (!account.canDo('post')) throw new Error(`@${account.username}: daily post cap reached`);

    // Force fresh session — re-login if tokens expired
    await AuthSvc.ensureSession(account);
    const page = await Browser.getPage(account);
    const t0   = Date.now();

    try {
      // الذهاب مباشرة لصفحة الكتابة بدل home + ضغط زر compose
      await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60_000 });

      if (page.url().includes('/login')) throw new Error(`Session expired for @${account.username}`);

      // انتظر الـ textarea بطريقتين — أيهما أسرع
      await Promise.race([
        page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 60_000 }),
        page.waitForSelector('[role="textbox"]', { timeout: 60_000 }),
      ]);
      await sleep(500, 800);
      const box = page.locator(SEL.tweetBox).first();
      await box.evaluate(el => el.focus());
      await sleep(500, 800);

      // Clear any existing text
      await page.keyboard.press('Control+a');
      await sleep(100, 200);
      await page.keyboard.press('Backspace');
      await sleep(300, 500);

      // Type text
      await this._humanType(page, content.text);
      await sleep(1200, 2000);

      // Verify text landed
      const boxText = await box.textContent().catch(() => '');
      logger.info(`[Action] Tweet compose: ${boxText.length} chars @${account.username}`);

      if (boxText.trim().length === 0) {
        throw new Error(`Text did not land in tweet box for @${account.username}`);
      }

      // Media
      if (content.mediaLocalPaths?.length) {
        const valid = content.mediaLocalPaths.filter(p => fs.existsSync(p)).slice(0, 4);
        if (valid.length) {
          const inp = await page.$(SEL.fileInput);
          if (inp) { await inp.setInputFiles(valid); await sleep(2500, 4000); }
        }
      }

      // Submit — use Locator for reliable enabled check
      // Try tweetButtonInline first (inside compose modal), fallback to tweetButton
      const submitLocator = page.locator(`${SEL.tweetBtnInline}, ${SEL.tweetBtn}`).first();

      // Wait up to 8s for button to become enabled
      let btnEnabled = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const count = await submitLocator.count().catch(() => 0);
        if (count > 0) {
          btnEnabled = await submitLocator.isEnabled().catch(() => false);
          if (btnEnabled) break;
        }
        await sleep(800, 1200);
      }

      if (!btnEnabled) {
        const boxContent = await box.textContent().catch(() => '');
        throw new Error(`Tweet button stayed disabled — box: "${boxContent.slice(0,60)}" (${boxContent.length} chars)`);
      }

      await submitLocator.evaluate(el => el.click());
      await sleep(3000, 5000);

      const url     = page.url();
      const tweetId = url.match(/\/status\/(\d+)/)?.[1] || null;

      await account.bump('post');
      await Browser.persistSession(account);
      await log(account._id, 'publish', 'tweet_posted', 'success', { tweetId, ms: Date.now()-t0 });
      if (global.io) global.io.emit('action:done', { type:'tweet', account:account.username, tweetId });

      logger.info(`[Action] Tweet posted: @${account.username} ${tweetId||''} (${Date.now()-t0}ms)`);
      return { success:true, tweetId, tweetUrl: tweetId ? `https://x.com/${account.username}/status/${tweetId}` : null };

    } catch (e) {
      await log(account._id, 'publish', 'tweet_failed', 'failure', { error:e.message });
      logger.error(`[Action] Tweet failed @${account.username}: ${e.message}`);
      throw e;
    } finally {
      await page.close().catch(() => {});
    }
  },

  // ── Multi-account tweet ───────────────────────────────────────
  async tweetMulti(accounts, textOrFn, opts = {}) {
    const { delayBetweenMs = [8000, 20000], mediaLocalPaths = [] } = opts;
    const results = [];
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const text    = typeof textOrFn === 'function' ? textOrFn(account) : textOrFn;
      try {
        const r = await this.tweet(account, { text, mediaLocalPaths });
        results.push({ username: account.username, ...r });
      } catch (e) {
        results.push({ username: account.username, success: false, error: e.message });
      }
      if (i < accounts.length - 1) await sleep(delayBetweenMs[0], delayBetweenMs[1]);
    }
    return results;
  },

  // ── Like ─────────────────────────────────────────────────────
  async like(account, tweetId) {
    if (!account.canDo('like')) throw new Error(`@${account.username}: daily like cap reached`);
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="like"], [data-testid="unlike"]', { timeout: 60_000 });
      await sleep(800, 1200);
      const already = await page.locator('[data-testid="unlike"]').count().catch(() => 0);
      if (already > 0) return { success: true, alreadyLiked: true };
      await page.locator('[data-testid="like"]').first().evaluate(el => el.click());
      await sleep(800, 1500);
      await account.bump('like');
      await log(account._id, 'engage', 'like', 'success', { tweetId });
      return { success: true };
    } catch (e) {
      await log(account._id, 'engage', 'like_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

  // ── Retweet ───────────────────────────────────────────────────
  async retweet(account, tweetId) {
    if (!account.canDo('repost')) throw new Error(`@${account.username}: daily retweet cap reached`);
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // انتظر زر الريتويت أو unretweet مباشرة — نفس نهج like
      await page.waitForSelector('[data-testid="retweet"], [data-testid="unretweet"]', { timeout: 60_000 });
      await sleep(800, 1200);

      const already = await page.locator('[data-testid="unretweet"]').count().catch(() => 0);
      if (already > 0) return { success: true, alreadyRetweeted: true };

      // اضغط زر الريتويت عبر locator
      await page.locator('[data-testid="retweet"]').first().evaluate(el => el.click());

      // انتظر dialog التأكيد قبل الضغط
      await page.waitForSelector('[data-testid="retweetConfirm"]', { timeout: 10_000 });
      await sleep(400, 700);
      await page.locator('[data-testid="retweetConfirm"]').first().evaluate(el => el.click());
      await sleep(1000, 1800);

      await account.bump('repost');
      await log(account._id, 'engage', 'retweet', 'success', { tweetId });
      return { success: true };
    } catch (e) {
      await log(account._id, 'engage', 'retweet_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

    // ── Reply ─────────────────────────────────────────────────────
  async reply(account, tweetId, text, mediaLocalPaths = []) {
    if (!account.canDo('reply')) throw new Error(`@${account.username}: daily reply cap reached`);
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // انتظر ظهور زر الرد
      await page.waitForSelector('[data-testid="reply"]', { timeout: 60_000 });
      await sleep(1000, 1500);

      // اضغط زر الرد عبر JS
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="reply"]');
        if (btn) btn.click();
      });
      await sleep(1500, 2500);

      // انتظر صندوق الكتابة
      await Promise.race([
        page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 30_000 }),
        page.waitForSelector('[role="textbox"]', { timeout: 30_000 }),
      ]);
      await sleep(500, 800);

      const replyBox = page.locator(SEL.tweetBox).last();
      await replyBox.evaluate(el => el.focus());
      await sleep(500, 800);
      // اكتب مباشرة على الـ locator بدل page
      await replyBox.type(text, { delay: 40 });
      await sleep(800, 1200);

      // رفع الصور إذا وجدت
      if (mediaLocalPaths?.length) {
        const fileInput = await page.$('input[type="file"][accept*="image"]').catch(() => null);
        if (fileInput) {
          await fileInput.setInputFiles(mediaLocalPaths);
          await sleep(2000, 3000);
        }
      }

      // انتظر زر الإرسال ثم اضغطه
      const replySubmit = page.locator('[data-testid="tweetButtonInline"]').first();
      await replySubmit.waitFor({ state: 'visible', timeout: 15_000 });
      await replySubmit.evaluate(el => el.click());
      await sleep(2000, 3000);

      await account.bump('reply');
      await log(account._id, 'engage', 'reply', 'success', { tweetId });
      return { success: true };
    } catch (e) {
      await log(account._id, 'engage', 'reply_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

// ── Follow ────────────────────────────────────────────────────
  // ── إبلاغ عن حساب ──────────────────────────────────────────
  async reportAccount(account, targetHandle, reason = 'spam') {
    const page = await this._readyPage(account);
    const handle = targetHandle.replace('@', '');
    try {
      await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(2000, 3000);

      // انتظر تحميل الصفحة
      await page.waitForSelector('[data-testid="UserName"], [data-testid="userActions"]', { timeout: 30_000 });
      await sleep(1500, 2000);

      // افتح قائمة الخيارات
      const acctBtnSelectors = [
        '[data-testid="userActions"]',
        'button[aria-label="More"]',
        '[aria-label*="More options"]',
      ];
      let clicked = false;
      for (const sel of acctBtnSelectors) {
        const count = await page.locator(sel).count().catch(() => 0);
        if (count > 0) {
          await page.locator(sel).first().evaluate(el => el.click());
          clicked = true;
          break;
        }
      }
      if (!clicked) throw new Error('لم يتم إيجاد قائمة الخيارات');
      await sleep(800, 1200);

      // اضغط Report
      await sleep(600, 900);
      const rptClicked = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"], [data-testid="report"]')];
        const btn = items.find(el => el.textContent.trim().toLowerCase().includes('report'));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!rptClicked) throw new Error('لم يتم إيجاد خيار الإبلاغ');
      await sleep(1200, 1800);

      // اختر السبب — الأول محدد تلقائياً
      await page.locator('[role="radio"]').first().evaluate(el => el.click()).catch(() => {});
      await sleep(800, 1200);

      // اضغط Next خطوة خطوة
      for (let step = 0; step < 6; step++) {
        await sleep(1200, 1800);
        // اختر أول radio
        await page.evaluate(() => {
          const r = document.querySelector('[role="radio"]');
          if (r) r.click();
        }).catch(() => {});
        await sleep(500, 700);
        // اضغط Next
        const next = page.locator('button:text-is("Next")').first();
        const hasNext = await next.count().catch(() => 0);
        if (!hasNext) break;
        await next.click().catch(() => {});
      }

      await log(account._id, 'engage', 'report_account', 'success', { target: targetHandle, reason });
      logger.info(`[Action] Report account: @${handle} by @${account.username}`);
      return { success: true };
    } catch (e) {
      await log(account._id, 'engage', 'report_account', 'failure', { target: targetHandle, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

  // ── إبلاغ عن تغريدة ─────────────────────────────────────────
  async reportTweet(account, tweetUrl, reason = 'spam') {
    const page = await this._readyPage(account);
    try {
      await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(2000, 3000);

      // انتظر تحميل التغريدة
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30_000 });
      await sleep(1500, 2000);

      // افتح قائمة الخيارات على التغريدة — جرب selectors متعددة
      const moreBtnSelectors = [
        'article[data-testid="tweet"] [data-testid="caret"]',
        'article[data-testid="tweet"] button[aria-label="More"]',
        'article[data-testid="tweet"] [aria-haspopup="menu"]',
      ];
      let moreBtn = null;
      for (const sel of moreBtnSelectors) {
        const count = await page.locator(sel).count().catch(() => 0);
        if (count > 0) { moreBtn = page.locator(sel).first(); break; }
      }
      if (!moreBtn) throw new Error('لم يتم إيجاد زر الخيارات');
      await moreBtn.evaluate(el => el.click());
      await sleep(800, 1200);

      // اضغط Report post
      await sleep(600, 900);
      const reportClicked = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[role="menuitem"], [data-testid="report"]')];
        const btn = items.find(el => el.textContent.trim().toLowerCase().includes('report'));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (!reportClicked) throw new Error('لم يتم إيجاد خيار الإبلاغ');
      await sleep(1200, 1800);

      // اختر السبب — الأول محدد تلقائياً
      await page.locator('[role="radio"]').first().evaluate(el => el.click()).catch(() => {});
      await sleep(800, 1200);

      // اضغط Next خطوة خطوة
      for (let step = 0; step < 6; step++) {
        await sleep(1200, 1800);
        // اختر أول radio
        await page.evaluate(() => {
          const r = document.querySelector('[role="radio"]');
          if (r) r.click();
        }).catch(() => {});
        await sleep(500, 700);
        // اضغط Next
        const next = page.locator('button:text-is("Next")').first();
        const hasNext = await next.count().catch(() => 0);
        if (!hasNext) break;
        await next.click().catch(() => {});
      }

      await log(account._id, 'engage', 'report_tweet', 'success', { tweetUrl, reason });
      logger.info(`[Action] Report tweet: ${tweetUrl} by @${account.username}`);
      return { success: true };
    } catch (e) {
      await log(account._id, 'engage', 'report_tweet', 'failure', { tweetUrl, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

  async follow(account, targetHandle) {
    if (!account.canDo('follow')) throw new Error(`@${account.username}: daily follow cap reached`);
    const page = await this._readyPage(account);
    try {
      const cleanHandle = targetHandle.replace(/^@+/, '');
      await page.goto(`https://x.com/${cleanHandle}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(2000, 3000);
      await this._checkNotRedirected(page, account);

      // تحقق من Cloudflare
      const currentUrl = page.url();
      if (currentUrl.includes('/account/access') || currentUrl.includes('Just a moment')) {
        account.status = 'نقطة_تحقق';
        account.lastCheckedAt = new Date();
        await account.save().catch(() => {});
        throw new Error(`SKIP:@${account.username} — نقطة_تحقق`);
      }

      // تجاوز تحذير "This account is temporarily restricted"
      // نستخدم waitForSelector بدل $ لأن الصفحة ممكن ما تحملت كامل
      const warningBtn = await page.waitForSelector(
        'button:has-text("Yes, view profile"), button:has-text("Yes, view")',
        { state: 'visible', timeout: 5_000 }
      ).catch(() => null);
      if (warningBtn) {
        logger.info(`[Follow] @${account.username} — تجاوز تحذير restricted`);
        await warningBtn.click();
        // انتظر حتى يختفي التحذير ويظهر المحتوى
        await page.waitForSelector('[data-testid="primaryColumn"]', { timeout: 10_000 }).catch(() => {});
        await sleep(1000, 1500);
      }

      // كشف صفحة الخطأ "Try again" — يعني React ما hydrate
      const hasTryAgain = await page.evaluate(() => {
        return [...document.querySelectorAll('button')].some(b => /try again/i.test(b.textContent.trim()));
      }).catch(() => false);

      if (hasTryAgain) {
        logger.info(`[Follow] @${account.username} — صفحة خطأ، إعادة تحميل كاملة...`);
        // reload بـ networkidle يضمن تحميل React كامل
        await page.reload({ waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
        await sleep(2000, 3000);
        await this._checkNotRedirected(page, account);
        // تحقق مرة ثانية
        const stillBroken = await page.evaluate(() =>
          [...document.querySelectorAll('button')].some(b => /try again/i.test(b.textContent.trim()))
        ).catch(() => false);
        if (stillBroken) throw new Error(`SKIP:@${account.username} — X رفض تحميل الصفحة`);
      }

      // انتظر تحميل المحتوى — X.com SPA تحتاج وقت بعد domcontentloaded
      await sleep(1500, 2500);

      // انتظر userActions أو primaryColumn
      await Promise.race([
        page.waitForSelector('[data-testid="userActions"]',       { timeout: 15_000 }),
        page.waitForSelector('[data-testid="placementTracking"]', { timeout: 15_000 }),
        page.waitForSelector('[data-testid="primaryColumn"]',     { timeout: 15_000 }),
      ]).catch(() => {});

      // انتظر زر المتابعة نفسه يظهر (بدل sleep ثابت)
      // X SPA يحمّل userActions أولاً ثم يضيف الأزرار
      await Promise.race([
        page.waitForSelector('[data-testid$="-follow"]:not([data-testid$="-unfollow"])', { timeout: 5_000 }),
        page.waitForSelector('[aria-label^="Follow @"]',   { timeout: 5_000 }),
        page.waitForSelector('[data-testid$="-unfollow"]', { timeout: 5_000 }), // يتابعه مسبقاً
      ]).catch(() => {}); // لو ما وجد — نكمل للـ evaluate
      await sleep(300, 500);

      logger.info(`[Follow] @${account.username} — searching for follow button on ${targetHandle}`);

      // المحاولة 1: انتظر الزر عبر locator (أكثر موثوقية من evaluate)
      const followSelectors = [
        '[data-testid$="-follow"]:not([data-testid$="-unfollow"])',
        '[aria-label^="Follow @"]',
        '[aria-label^="متابعة @"]',
        '[data-testid="follow"]',
      ];
      let clicked = null;
      for (const sel of followSelectors) {
        const loc = page.locator(sel).first();
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
          await loc.click();
          clicked = sel.includes('aria') ? 'aria' : sel.includes('testid') ? 'testid' : 'end-follow';
          break;
        }
      }

      // المحاولة 2: evaluate بحث شامل (للزر ذو النص الفارغ)
      if (!clicked) {
        clicked = await page.evaluate(() => {
          // تحقق إذا يتابعه مسبقاً
          const already = document.querySelector('[data-testid$="-unfollow"],[aria-label^="Following @"],[aria-label^="Unfollow @"]');
          if (already) return 'already';

          // بحث في كل الأزرار المرئية داخل userActions
          const zone = document.querySelector('[data-testid="userActions"]') || document.body;
          const btns = [...zone.querySelectorAll('button,[role="button"]')];

          // زر المتابعة في X.com: style يشمل background-color أخضر أو له data-testid
          const byTestId = btns.find(b => {
            const tid = b.getAttribute('data-testid') || '';
            return tid.endsWith('-follow') && !tid.endsWith('-unfollow');
          });
          if (byTestId) { byTestId.click(); return 'testid-zone'; }

          // بحث بالـ aria-label على أي عنصر
          const byAria = document.querySelector('[aria-label^="Follow "],[aria-label^="متابعة "]');
          if (byAria) { byAria.click(); return 'aria-full'; }

          // آخر محاولة: أي زر غير More وغير اسم الحساب في الـ header
          const candidate = btns.find(b => {
            const tid = b.getAttribute('data-testid') || '';
            const txt = b.textContent.trim();
            // استبعد الأزرار المعروفة
            return !tid.includes('unfollow') && !tid.includes('More') &&
                   !tid.includes('message') && !tid.includes('share') &&
                   txt !== 'More' && !txt.includes('@') && b.offsetParent !== null;
          });
          if (candidate) { candidate.click(); return 'candidate'; }

          return null;
        }).catch(() => null);
      }

      logger.info(`[Follow] @${account.username} — clicked: ${clicked}`);
      if (clicked === 'already') return { success: true, alreadyFollowing: true };
      if (!clicked) {
        // تشخيص — ماذا يوجد في الصفحة
        const pageInfo = await page.evaluate(() => ({
          url: location.href,
          hasProtected: !!document.querySelector('[data-testid="UserDescription"]'),
          btns: [...document.querySelectorAll('button')].slice(0,5).map(b => b.textContent.trim()),
        })).catch(() => ({}));
        logger.warn(`[Follow] page info: ${JSON.stringify(pageInfo)}`);
        // "See new posts" = يتابعه مسبقاً
        const alreadyIndicators = ['See new posts', 'New posts', 'Show new posts'];
        const isAlready = pageInfo.btns?.some(b => alreadyIndicators.some(i => b.includes(i)));
        if (isAlready) {
          logger.info(`[Follow] @${account.username} — يتابع @${targetHandle} مسبقاً (See new posts)`);
          return { success: true, alreadyFollowing: true };
        }
        throw new Error('لم يتم إيجاد زر المتابعة');
      }

      logger.info(`[Action] Follow btn clicked via: ${clicked} @${targetHandle}`);
      // انتظر تأكيد المتابعة — X يأخذ 1-3 ثوانٍ لتغيير الزر
      await sleep(1500, 2000);
      // تحقق من التأكيد — ننتظر الزر يتغير بدل sleep ثابت
      await Promise.race([
        page.waitForSelector('[data-testid$="-unfollow"]',    { timeout: 4_000 }),
        page.waitForSelector('[aria-label^="Following @"]',   { timeout: 4_000 }),
        page.waitForSelector('[aria-label^="Unfollow @"]',    { timeout: 4_000 }),
      ]).catch(() => {});
      const confirmed = await page.evaluate(() => {
        // كشف كل علامات المتابعة الناجحة بما فيها See new posts
        const hasUnfollow = !!(
          document.querySelector('[data-testid$="-unfollow"]') ||
          document.querySelector('[aria-label^="Following @"]') ||
          document.querySelector('[aria-label^="Unfollow @"]')
        );
        const hasSeeNew = [...document.querySelectorAll('button')]
          .some(b => /see new posts|new posts/i.test(b.textContent));
        return hasUnfollow || hasSeeNew;
      }).catch(() => true);
      logger.info(`[Action] Follow confirmed: ${confirmed} @${targetHandle}`);
      await account.bump('follow');
      await log(account._id, 'engage', 'follow', 'success', { target: targetHandle });
      return { success: true };
    } catch (e) {
      logger.error(`[Follow] @${account.username} → @${targetHandle} ERROR: ${e.message}`);
      await log(account._id, 'engage', 'follow_failed', 'failure', { target: targetHandle, error: e.message });
      throw e;
    } finally {
      logger.info(`[Follow] @${account.username} — closing page`);
      await page.close().catch(() => {});
    }
  },

    // ── Engagement campaign ───────────────────────────────────────
  async engageTweet(accounts, tweetId, actions, opts = {}) {
    const { replyTexts = [], delayBetweenMs = [5000, 15000] } = opts;
    const results = [];
    let replyIdx  = 0;
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const r       = { username: account.username, tweetId, actions: {} };
      for (const action of actions) {
        try {
          if      (action === 'like')    r.actions.like    = await this.like(account, tweetId);
          else if (action === 'retweet') r.actions.retweet = await this.retweet(account, tweetId);
          else if (action === 'reply' && replyTexts.length) {
            r.actions.reply = await this.reply(account, tweetId, replyTexts[replyIdx++ % replyTexts.length]);
          }
          await sleep(2000, 5000);
        } catch (e) {
          r.actions[action] = { success:false, error:e.message };
          logger.warn(`[Action] engageTweet ${action} @${account.username}: ${e.message}`);
        }
      }
      results.push(r);
      if (i < accounts.length - 1) await sleep(delayBetweenMs[0], delayBetweenMs[1]);
    }
    return results;
  },

  // ── Search ────────────────────────────────────────────────────
  async search(account, keyword, maxResults = 20) {
    const page    = await this._readyPage(account);
    const results = [];
    try {
      await page.goto(`https://x.com/search?q=${encodeURIComponent(keyword)}&f=live`, { waitUntil:'domcontentloaded' });
      await sleep(2000, 3500);
      for (let i=0; i<3; i++) { await page.evaluate(()=>window.scrollBy(0,800)); await sleep(1200,2000); }
      const cards = await page.$$('[data-testid="tweet"]');
      for (const card of cards.slice(0, maxResults)) {
        try {
          const text   = await card.$eval('[data-testid="tweetText"]', e=>e.innerText).catch(()=>'');
          const link   = await card.$eval('a[href*="/status/"]', e=>e.href).catch(()=>'');
          const author = await card.$eval('[data-testid="User-Name"]', e=>e.innerText.split('\n')[0]).catch(()=>'');
          const id     = link.match(/\/status\/(\d+)/)?.[1];
          if (id && text) results.push({ id, text:text.slice(0,280), author, link });
        } catch {}
      }
      return results;
    } finally { await page.close().catch(()=>{}); }
  },

  // ── Update profile ────────────────────────────────────────────
  async updateProfile(account, updates = {}) {
    const fs = require('fs');

    // نستخدم getPage مباشرة بعد API verify — بدون _readyPage لتجنب race condition
    // _readyPage تضيف page.on('close')→persistSession اللي يتعارض مع closeContext
    await AuthSvc.ensureSession(account);
    const page = await Browser.getPage(account);

    try {
      // ── الانتقال مباشرة لصفحة إعدادات البروفايل ─────────
      await page.goto('https://x.com/settings/profile', {
        waitUntil: 'domcontentloaded',
        timeout: 40_000,
      }).catch(() => {});

      await sleep(1000, 1500);
      await this._checkNotRedirected(page, account);

      // انتظر ظهور الفورم — أي من هذه العناصر يكفي
      const formReady = await Promise.race([
        page.waitForSelector('input[name="displayName"]',          { state: 'visible', timeout: 20_000 }).then(() => 'displayName'),
        page.waitForSelector('[data-testid="Profile_Save_Button"]', { state: 'attached', timeout: 20_000 }).then(() => 'saveBtn'),
        page.waitForSelector('textarea[name="description"]',       { state: 'visible', timeout: 20_000 }).then(() => 'bio'),
      ]).catch(() => null);

      if (!formReady) {
        // الصفحة لم تحمّل الفورم — reload مرة واحدة
        logger.info(`[Action] @${account.username} — settings form timeout، reload...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        await sleep(2000, 3000);
        await this._checkNotRedirected(page, account);

        const retryReady = await Promise.race([
          page.waitForSelector('input[name="displayName"]',          { state: 'visible', timeout: 15_000 }).then(() => true),
          page.waitForSelector('[data-testid="Profile_Save_Button"]', { state: 'attached', timeout: 15_000 }).then(() => true),
        ]).catch(() => false);

        if (!retryReady) throw new Error(`SKIP:@${account.username} — settings/profile لم يحمّل`);
      }

      logger.info(`[Action] @${account.username} — ✓ settings/profile جاهز`);
      await sleep(500, 800);

      // ── رفع الصورة الشخصية ──────────────────────────────
      if (updates.avatarPath && fs.existsSync(updates.avatarPath)) {
        const avatarInputHandle = await page.evaluateHandle(() => {
          const inputs = document.querySelectorAll('input[data-testid="fileInput"]');
          return inputs[1] || null; // الثاني للأفاتار في X.com
        });
        const avatarInput = avatarInputHandle?.asElement?.();
        if (avatarInput) {
          await avatarInput.setInputFiles(updates.avatarPath);
          await sleep(3000, 4000);
          const applyBtn = await page.$('[data-testid="applyButton"]').catch(() => null);
          if (applyBtn) { await applyBtn.evaluate(el => el.click()); await sleep(2000, 3000); }
          logger.info(`[Action] @${account.username} — ✓ أفاتار رُفع`);
        }
      } else if (updates.avatarPath) {
        logger.warn(`[Action] @${account.username} — avatar path غير موجود: ${updates.avatarPath}`);
      }

      // ── رفع البانر ──────────────────────────────────────
      if (updates.bannerPath && fs.existsSync(updates.bannerPath)) {
        await sleep(1000, 1500);
        const bannerInputHandle = await page.evaluateHandle(() => {
          const inputs = document.querySelectorAll('input[data-testid="fileInput"]');
          return inputs[0] || null; // الأول للبانر في X.com
        });
        const bannerInput = bannerInputHandle?.asElement?.();
        if (bannerInput) {
          await bannerInput.setInputFiles(updates.bannerPath);
          await sleep(3000, 4000);
          const applyBtn = await page.$('[data-testid="applyButton"]').catch(() => null);
          if (applyBtn) { await applyBtn.evaluate(el => el.click()); await sleep(2000, 3000); }
          logger.info(`[Action] @${account.username} — ✓ بانر رُفع`);
        }
      } else if (updates.bannerPath) {
        logger.warn(`[Action] @${account.username} — banner path غير موجود: ${updates.bannerPath}`);
      }

      // ── تحديث النصوص ────────────────────────────────────
      // React inputs تحتاج nativeInputValueSetter لإطلاق onChange صحيح
      const fillReact = async (selector, value) => {
        const loc = page.locator(selector).first();
        const count = await loc.count().catch(() => 0);
        if (!count) { logger.warn(`[Action] @${account.username} — field not found: ${selector}`); return false; }
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ clickCount: 3 });
        await sleep(150, 250);
        // استخدم page.fill عبر locator — يُطلق input/change events كاملة
        await loc.fill('');
        await sleep(100);
        await loc.fill(String(value));
        // تحقق أن القيمة وصلت
        const actual = await loc.inputValue().catch(() => '');
        if (!actual && String(value).length > 0) {
          // fallback: type حرفاً حرفاً عبر keyboard
          await loc.click({ clickCount: 3 });
          await sleep(100);
          await page.keyboard.press('Control+a');
          await page.keyboard.press('Delete');
          await this._humanType(page, String(value));
        }
        await sleep(400, 600);
        logger.info(`[Action] @${account.username} — ✓ field filled: ${selector.match(/name="([^"]+)"/)?.[1] || selector}`);
        return true;
      };

      if (updates.displayName !== undefined) await fillReact('input[name="displayName"]',    updates.displayName);
      if (updates.bio         !== undefined) await fillReact('textarea[name="description"]', updates.bio);

      if (updates.location !== undefined) {
        const locSels = ['input[name="location"]', 'input[placeholder*="location" i]', 'input[placeholder*="موقع" i]'];
        for (const s of locSels) {
          if (await fillReact(s, updates.location)) break;
        }
      }
      if (updates.website !== undefined) {
        const webSels = ['input[name="url"]', 'input[name="website"]', 'input[placeholder*="website" i]'];
        for (const s of webSels) {
          if (await fillReact(s, updates.website)) break;
        }
      }

      // ── حفظ ──────────────────────────────────────────────
      const saved = await (async () => {
        // انتظر زر الحفظ
        const saveBtn = page.locator('[data-testid="Profile_Save_Button"]');
        try {
          await saveBtn.waitFor({ state: 'visible', timeout: 10_000 });
          await saveBtn.scrollIntoViewIfNeeded().catch(() => {});
          await sleep(300, 500);
          // locator.click() يُطلق pointer events كاملة — React يستجيب
          await saveBtn.click();
          logger.info(`[Action] @${account.username} — ✓ حُفظ`);
          return true;
        } catch (e) {
          logger.warn(`[Action] @${account.username} — save btn error: ${e.message}`);
        }
        // fallback: dispatch click مع pointer events
        const ok = await page.evaluate(() => {
          const b = document.querySelector('[data-testid="Profile_Save_Button"]')
            || [...document.querySelectorAll('button')].find(el => /save/i.test(el.textContent.trim()));
          if (!b) return false;
          b.dispatchEvent(new MouseEvent('mousedown', { bubbles:true }));
          b.dispatchEvent(new MouseEvent('mouseup',   { bubbles:true }));
          b.dispatchEvent(new MouseEvent('click',     { bubbles:true }));
          return true;
        }).catch(() => false);
        if (ok) { logger.info(`[Action] @${account.username} — ✓ حُفظ (dispatch)`); return true; }
        logger.warn(`[Action] @${account.username} — لم يُعثر على زر الحفظ`);
        return false;
      })();

      if (saved) await sleep(3000, 4000);

      // احفظ الجلسة قبل إغلاق الصفحة — مهم
      await Browser.persistSession(account).catch(() => {});
      await log(account._id, 'profile', 'profile_updated', 'success', { fields: Object.keys(updates) });
      return { success: true, updated: Object.keys(updates) };

    } catch (e) {
      await log(account._id, 'profile', 'profile_update_failed', 'failure', { error: e.message }).catch(() => {});
      throw e;
    } finally {
      // نغلق الصفحة فقط — closeContext يتولاها bulkUpdateProfiles بعد انتهاء الـ batch
      await page.close().catch(() => {});
    }
  },

  // ── Sync profile stats ────────────────────────────────────────
  async syncProfile(account) {
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/${account.username}`, { waitUntil:'domcontentloaded' });
      await sleep(1500, 2500);
      const parseCount = s => {
        if (!s) return 0;
        const n = s.replace(/,/g,'').trim();
        if (n.endsWith('K')) return Math.round(parseFloat(n)*1000);
        if (n.endsWith('M')) return Math.round(parseFloat(n)*1_000_000);
        return parseInt(n,10)||0;
      };
      const [name,bio,followers,following] = await Promise.all([
        page.$eval('[data-testid="UserName"] span',          e=>e.textContent).catch(()=>null),
        page.$eval('[data-testid="UserDescription"]',        e=>e.textContent).catch(()=>null),
        page.$eval('a[href$="/verified_followers"] span',    e=>e.textContent).catch(()=>null),
        page.$eval('a[href$="/following"] span',             e=>e.textContent).catch(()=>null),
      ]);
      account.profile = {
        displayName:    name?.trim()     || account.username,
        bio:            bio?.trim()      || '',
        followersCount: parseCount(followers),
        followingCount: parseCount(following),
        lastSyncedAt:   new Date(),
      };
      await account.save();
      return account.profile;
    } finally { await page.close().catch(()=>{}); }
  },

  // ── Helpers ───────────────────────────────────────────────────
  async _checkNotRedirected(page, account) {
    const url = page.url();
    if (url.includes('/i/flow/login') || url.includes('/account/access') || url.includes('/i/flow/password_reset')) {
      account.status        = 'يحتاج_مصادقة';
      account.lastCheckedAt = new Date();
      await account.save().catch(() => {});
      // احذف الجلسة المحفوظة — انتهت صلاحيتها
      const Vault = require('./vault.service');
      await Vault.deleteSession(account._id.toString()).catch(() => {});
      logger.warn(`[Action] @${account.username} — redirected to login, session deleted`);
      throw new Error(`SKIP:@${account.username} — يحتاج_مصادقة`);
    }
    if (url.includes('/suspended')) {
      account.status        = 'موقوف';
      account.lastCheckedAt = new Date();
      await account.save().catch(() => {});
      throw new Error(`SKIP:@${account.username} — موقوف`);
    }
  },

  // ── readyPage بدون classify — للعمليات التي تعرف وجهتها مسبقاً ──
  // تبني الـ context من الجلسة المحفوظة/tokens مباشرة بدون فتح x.com/home
  // العملية نفسها تتحقق من login redirect بعد goto()
  async _readyPageDirect(account) {
    const ctx  = await Browser.getContext(account);
    const page = await ctx.newPage();
    page.setDefaultTimeout(120_000);
    page.setDefaultNavigationTimeout(120_000);
    // لا نضيف persistSession هنا — updateProfile تستدعيه بشكل صريح قبل page.close()
    // إضافته هنا تسبب race condition مع closeContext في bulkUpdateProfiles
    return page;
  },

  async _readyPage(account) {
    await AuthSvc.ensureSession(account);
    const page = await Browser.getPage(account);

    // عرض الـ IP
    const hasProxy = !!account.network?.proxyUrl;
    // logger.info(`[IP] @${account.username} — proxy: ${hasProxy ? '✅ ' + (account.network.proxyUrl.split('@')[1] || '') : '❌ بدون بروكسي'}`);

    // لا نغلق الصفحة تلقائياً — _checkNotRedirected يتولى الأمر

    // كشف "Try again" و "Yes, view profile" بعد أي تنقل
    page.on('load', async () => {
      try {
        // تجاوز تحذير restricted تلقائياً
        const viewBtn = await page.$('button:has-text("Yes, view profile"), button:has-text("Yes, view")').catch(() => null);
        if (viewBtn) {
          await viewBtn.click().catch(() => {});
          await sleep(1000, 1500);
        }
        // إعادة تحميل عند صفحة الخطأ
        const broken = await page.evaluate(() =>
          [...document.querySelectorAll('button')].some(b => /^try again$/i.test(b.textContent.trim()))
        ).catch(() => false);
        if (broken) {
          await page.reload({ waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
        }
      } catch {}
    });

    // أغلق popup الكوكيز بعد أي تنقل
    page.on('load', async () => {
      await page.evaluate(() => {
        const texts = ['Aceitar','Accept','Recusar','Decline','Got it','كل ملفات','قبول'];
        const btn = [...document.querySelectorAll('button')]
          .find(b => texts.some(t => b.textContent.trim().startsWith(t)));
        if (btn) btn.click();
      }).catch(() => {});
    });

    // احفظ الجلسة عند إغلاق الصفحة عشان الحساب التالي يستفيد منها
    page.on('close', async () => {
      await Browser.persistSession(account).catch(() => {});
    });

    return page;
  },

  // ── جلب نص التغريدة ──────────────────────────────────────────
  async getTweetText(account, tweetId) {
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="tweetText"]', { timeout: 30_000 });
      const text = await page.$eval('[data-testid="tweetText"]', el => el.textContent).catch(() => '');
      return text.trim();
    } finally { await page.close().catch(() => {}); }
  },

  async _humanType(page, text) {
    for (const ch of String(text)) {
      await page.keyboard.type(ch, { delay: randInt(30, 70) });
    }
  },
};

module.exports = ActionSvc;