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
      await page.waitForSelector('[data-testid="tweet"]', { timeout: 60_000 });
      await sleep(1000, 1500);
      const already = await page.locator('[data-testid="unretweet"]').count().catch(() => 0);
      if (already > 0) return { success: true, alreadyRetweeted: true };
      await page.evaluate(() => { document.querySelector('[data-testid="retweet"]')?.click(); });
      await sleep(800, 1200);
      await page.evaluate(() => { document.querySelector('[data-testid="retweetConfirm"]')?.click(); });
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
  async reply(account, tweetId, text) {
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

      // اضغط Next حتى ينتهي
      for (let step = 0; step < 6; step++) {
        await sleep(1500, 2000);

        // اختر أول radio غير محدد إذا وجد
        await page.evaluate(() => {
          const radios = [...document.querySelectorAll('[role="radio"]')];
          const unchecked = radios.find(r => r.getAttribute('aria-checked') !== 'true');
          if (unchecked) unchecked.click();
          else if (radios[0]) radios[0].click();
        }).catch(() => {});
        await sleep(400, 600);

        // اضغط Next أو Done
        const clicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const btn = btns.find(b => {
            const txt = b.textContent.trim().toLowerCase();
            return (txt === 'next' || txt === 'submit' || txt === 'done') && !b.disabled;
          });
          if (btn) { btn.click(); return btn.textContent.trim(); }
          return null;
        }).catch(() => null);

        if (!clicked) break;

        await sleep(1500, 2000);

        // تحقق من انتهاء الإبلاغ
        const done = await page.evaluate(() => {
          const txt = document.body.innerText.toLowerCase();
          return txt.includes('thanks') || txt.includes('report received') || !document.querySelector('[role="dialog"]');
        }).catch(() => false);

        if (done || clicked.toLowerCase() === 'done') break;
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

      // اضغط Next حتى ينتهي
      for (let step = 0; step < 6; step++) {
        await sleep(1500, 2000);

        // اختر أول radio غير محدد إذا وجد
        await page.evaluate(() => {
          const radios = [...document.querySelectorAll('[role="radio"]')];
          const unchecked = radios.find(r => r.getAttribute('aria-checked') !== 'true');
          if (unchecked) unchecked.click();
          else if (radios[0]) radios[0].click();
        }).catch(() => {});
        await sleep(400, 600);

        // اضغط Next أو Done
        const clicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button')];
          const btn = btns.find(b => {
            const txt = b.textContent.trim().toLowerCase();
            return (txt === 'next' || txt === 'submit' || txt === 'done') && !b.disabled;
          });
          if (btn) { btn.click(); return btn.textContent.trim(); }
          return null;
        }).catch(() => null);

        if (!clicked) break;

        await sleep(1500, 2000);

        // تحقق من انتهاء الإبلاغ
        const done = await page.evaluate(() => {
          const txt = document.body.innerText.toLowerCase();
          return txt.includes('thanks') || txt.includes('report received') || !document.querySelector('[role="dialog"]');
        }).catch(() => false);

        if (done || clicked.toLowerCase() === 'done') break;
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
      await page.goto(`https://x.com/${targetHandle.replace('@','')}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid^="follow"]', { timeout: 60_000 });
      await sleep(1000, 1500);
      const btn = page.locator('[data-testid^="follow"]').first();
      const txt = (await btn.innerText().catch(() => '')).toLowerCase();
      if (txt.includes('following') || txt.includes('unfollow')) return { success: true, alreadyFollowing: true };
      await btn.evaluate(el => el.click());
      await sleep(800, 1500);
      await account.bump('follow');
      await log(account._id, 'engage', 'follow', 'success', { target: targetHandle });
      return { success: true };
    } catch (e) {
      await log(account._id, 'engage', 'follow_failed', 'failure', { target: targetHandle, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
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
    const fs   = require('fs');
    const page = await this._readyPage(account);
    try {
      // فتح صفحة تعديل البروفايل
      await page.goto('https://x.com/settings/profile', { waitUntil: 'domcontentloaded', timeout: 35_000 });

      // تحقق الجلسة
      if (page.url().includes('/login')) throw new Error('جلسة منتهية');

      // أغلق popup الكوكيز — X.com يظهره بلغات مختلفة
      const closeCookies = async () => {
        const closed = await page.evaluate(() => {
          const texts = ['Aceitar todos os cookies','Accept all cookies','Recusar cookies','Decline'];
          for (const text of texts) {
            const btns = [...document.querySelectorAll('button')];
            const btn  = btns.find(b => b.textContent.trim().startsWith(text.slice(0,8)));
            if (btn) { btn.click(); return true; }
          }
          // أغلق بـ BottomBar
          const bb = document.querySelector('[data-testid="BottomBar"] button');
          if (bb) { bb.click(); return true; }
          return false;
        });
        if (closed) {
          await sleep(800, 1200);
          logger.info(`[Action] @${account.username} — أُغلق popup الكوكيز`);
        }
        return closed;
      };
      await closeCookies();

      // إذا فتح home بدل settings — اذهب مباشرة
      if (!page.url().includes('/settings/profile')) {
        await page.goto('https://x.com/settings/profile', { waitUntil: 'domcontentloaded', timeout: 35_000 });
        await sleep(1500, 2000);
      }

      // أغلق popup الكوكيز مرة ثانية إذا ظهر بعد التنقل
      const cookieBtn2 = await page.$('button:has-text("Aceitar"), button:has-text("Accept"), [data-testid="BottomBar"] button').catch(() => null);
      if (cookieBtn2) {
        await cookieBtn2.evaluate(el => el.click());
        await sleep(500, 800);
      }

      // انتظر ظهور الفورم
      const pageReady = await Promise.race([
        page.waitForSelector('input[name="displayName"]',          { state: 'visible', timeout: 12_000 }).then(() => 'form'),
        page.waitForSelector('[data-testid="fileInput"]',           { state: 'attached', timeout: 12_000 }).then(() => 'inputs'),
        page.waitForSelector('[data-testid="Profile_Save_Button"]', { state: 'visible', timeout: 12_000 }).then(() => 'save'),
      ]).catch(() => 'timeout');

      logger.info(`[Action] @${account.username} — صفحة جاهزة: ${pageReady} | URL: ${page.url()}`);
      await page.screenshot({ path: `./data/debug/profile2_${account.username}.png` }).catch(() => {});

      // إذا timeout — الصفحة ما حملت الفورم، نجرب scroll أو reload
      if (pageReady === 'timeout') {
        logger.info(`[Action] @${account.username} — timeout، جارٍ reload...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await sleep(3000, 4000);

        // أغلق كوكيز مرة ثانية
        await closeCookies();

        await Promise.race([
          page.waitForSelector('input[name="displayName"]',          { state: 'visible', timeout: 12_000 }).then(() => {}),
          page.waitForSelector('[data-testid="fileInput"]',           { state: 'attached', timeout: 12_000 }).then(() => {}),
          page.waitForSelector('[data-testid="Profile_Save_Button"]', { state: 'visible', timeout: 12_000 }).then(() => {}),
        ]).catch(() => {});
      }

      await sleep(1000, 1500);

      // ── رفع الصورة الشخصية ──────────────────────────────────
      // الطريقة الصحيحة: X.com عنده label فوق كل input — الأول للأفاتار والثاني للبانر
      if (updates.avatarPath) {
        if (!fs.existsSync(updates.avatarPath)) {
          logger.warn(`[Action] الصورة غير موجودة: ${updates.avatarPath}`);
        } else {
          // البحث عن input الأفاتار باستخدام موقعه في DOM
          const avatarInputHandle = await page.evaluateHandle(() => {
            const inputs = document.querySelectorAll('input[data-testid="fileInput"]');
            return inputs[1] || null; // الثاني للأفاتار (الأول للبانر في X.com)
          });
          if (avatarInputHandle) {
            const avatarInput = avatarInputHandle.asElement();
            if (avatarInput) {
              await avatarInput.setInputFiles(updates.avatarPath);
              await sleep(3000, 4000);
              // X.com يفتح crop dialog — اضغط Apply
              const applyBtn = await page.$('[data-testid="applyButton"]').catch(() => null);
              if (applyBtn) {
                await applyBtn.evaluate(el => el.click());
                await sleep(2000, 3000);
              }
              logger.info(`[Action] @${account.username} — ✓ الصورة الشخصية رُفعت`);
            }
          }
        }
      }

      // ── رفع البانر ──────────────────────────────────────────
      if (updates.bannerPath) {
        if (!fs.existsSync(updates.bannerPath)) {
          logger.warn(`[Action] البانر غير موجود: ${updates.bannerPath}`);
        } else {
          // انتظر قليلاً بعد الأفاتار قبل البانر
          await sleep(1000, 1500);
          const bannerInputHandle = await page.evaluateHandle(() => {
            const inputs = document.querySelectorAll('input[data-testid="fileInput"]');
            return inputs[0] || null; // الأول للبانر في X.com
          });
          if (bannerInputHandle) {
            const bannerInput = bannerInputHandle.asElement();
            if (bannerInput) {
              await bannerInput.setInputFiles(updates.bannerPath);
              await sleep(3000, 4000);
              const applyBtn = await page.$('[data-testid="applyButton"]').catch(() => null);
              if (applyBtn) {
                await applyBtn.evaluate(el => el.click());
                await sleep(2000, 3000);
              }
              logger.info(`[Action] @${account.username} — ✓ البانر رُفع`);
            }
          }
        }
      }

      // ── تحديث النصوص ────────────────────────────────────────
      if (updates.displayName !== undefined) {
        const inp = await page.$(SEL.displayNameInput);
        if (inp) {
          await inp.click({ clickCount: 3 });
          await sleep(150, 250);
          await page.keyboard.press('Backspace');
          await this._humanType(page, updates.displayName);
          await sleep(400, 700);
        }
      }
      if (updates.bio !== undefined) {
        const bioEl = await page.$(SEL.bioInput);
        if (bioEl) {
          await bioEl.click({ clickCount: 3 });
          await sleep(150, 250);
          await page.keyboard.press('Backspace');
          await this._humanType(page, updates.bio);
          await sleep(400, 700);
        }
      }
      if (updates.location !== undefined) { await page.fill(SEL.locationInput, updates.location); await sleep(300, 600); }
      if (updates.website  !== undefined) { await page.fill(SEL.websiteInput,  updates.website);  await sleep(300, 600); }

      // ── تفعيل زر الحفظ وضغطه ────────────────────────────────
      // لازم نلمس أي حقل عشان يتفعّل الزر حتى لو رفعنا صور فقط
      const nameField = await page.$(SEL.displayNameInput);
      if (nameField) {
        const currentVal = await nameField.inputValue().catch(() => '');
        await nameField.fill(currentVal + ' ');
        await sleep(200, 300);
        await nameField.fill(currentVal);
        await sleep(300, 500);
      }

      // انتظر الزر يصير فعّال
      const saveBtn = page.locator('[data-testid="Profile_Save_Button"]');
      await saveBtn.waitFor({ state: 'visible', timeout: 8_000 });
      await sleep(500, 800);
      await saveBtn.evaluate(el => el.click());
      logger.info(`[Action] @${account.username} — ✓ البروفايل حُفظ`);
      await sleep(3000, 4000);

      await Browser.persistSession(account);
      await log(account._id, 'profile', 'profile_updated', 'success', { fields: Object.keys(updates) });
      return { success:true, updated:Object.keys(updates) };
    } catch (e) {
      await log(account._id, 'profile', 'profile_update_failed', 'failure', { error:e.message });
      throw e;
    } finally { await page.close().catch(()=>{}); }
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
  async _readyPage(account) {
    await AuthSvc.ensureSession(account);
    const page = await Browser.getPage(account);

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