'use strict';
const fs      = require('fs');
const path    = require('path');
const Browser = require('./browser.service');
const AuthSvc = require('./auth.service');
const { log } = require('../models/index');
const logger  = require('../utils/logger');
const { sleep, randInt } = require('../utils/delay');
const Sel     = require('../x/selectors');   // السجل المركزي اللغة-المحايد
const dom     = require('../x/dom');          // resolver + تفاعل متحقّق
const { swallow } = require('../utils/swallow'); // بديل آمن لـ .catch(()=>{}) الأعمى
const ProxyBreaker = require('../ops/proxy-breaker'); // قاطع دائرة لكل حساب

const SEL = {
  composeBtn:    '[data-testid="SideNav_NewTweet_Button"]',
  tweetBox:      '[data-testid="tweetTextarea_0"]',
  tweetBtnInline:'[data-testid="tweetButtonInline"]',
  tweetBtn:      '[data-testid="tweetButton"]',
  fileInput:     '[data-testid="fileInput"]',
  mediaPreview:  '[data-testid="attachments"], [data-testid="mediaPreview"], [data-testid="tweetPhoto"], img[src^="blob:"], video',
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

function extractCreatedTweetId(payload) {
  const root = payload?.data?.create_tweet?.tweet_results?.result
    || payload?.data?.create_tweet?.tweet_results
    || payload?.data?.create_tweet;
  if (!root || typeof root !== 'object') return null;

  // Keep this path-specific. A broad recursive search may accidentally pick
  // the author's user rest_id from `core.user_results` and report a false post.
  const candidates = [
    root.rest_id,
    root.tweet?.rest_id,
    root.legacy?.id_str,
    root.result?.rest_id,
    root.result?.tweet?.rest_id,
    root.result?.legacy?.id_str,
    root.tweet_results?.result?.rest_id,
    root.tweet_results?.result?.legacy?.id_str,
  ];
  for (const candidate of candidates) {
    if (/^\d+$/.test(String(candidate || ''))) return String(candidate);
  }
  return null;
}

const ActionSvc = {

  // ── Tweet ─────────────────────────────────────────────────────
  async tweet(account, content) {
    if (!account.canDo('post')) throw new Error(`@${account.username}: daily post cap reached`);

    // Force fresh session — re-login if tokens expired
    await AuthSvc.ensureSession(account);
    const page = await Browser.getPage(account);
    const t0   = Date.now();

    let navStatus = 'n/a';
    try {
      // الصفحة الرئيسية أخف وأكثر ثباتاً من فتح /compose/post مباشرة.
      // كما أنها تحتوي محرر inline؛ وإذا لم يظهر نفتح نافذة compose من الشريط.
      const navResp = await this._openTweetComposer(page, account);
      navStatus = navResp ? navResp.status() : 'no-resp';

      // انتظر مُحرّر الكتابة — وإلا خطأ صريح (auth/splash/فارغ) بدل timeout غامض
      const ready = await dom.present(page, Sel.compose.editor, { timeout: 5_000, state: 'visible' });
      if (!ready) {
        if (await dom.present(page, Sel.page.loginWall, { timeout: 1500 }))
          throw new Error(`SKIP:@${account.username} — auth_required (جدار دخول على صفحة الكتابة)`);
        const htmlLen = await page.evaluate(() => document.documentElement.outerHTML.length).catch(() => -1);
        const title   = await page.title().catch(() => '');
        if (htmlLen >= 0 && htmlLen < 600)
          throw new Error(`EmptyDocument: @${account.username} — صفحة الكتابة فارغة (${htmlLen}b)`);
        if (/^Loading/i.test(title) || !title)
          throw new Error(`StillLoading: @${account.username} — صفحة الكتابة لم تكتمل (splash) — قيد/بطء على الحساب`);
        throw new Error(`PageNotReady: صفحة الكتابة لم تُرسم (title="${title.slice(0, 40)}", navStatus=${navStatus})`);
      }
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

      // Media (صور حتى ٤، أو فيديو واحد — X لا يسمح بخلطهما)
      let hasVideo = false;
      let attachedFiles = [];
      let mediaPreviewBaseline = 0;
      if (content.mediaLocalPaths?.length) {
        const requested = content.mediaLocalPaths.map(path => String(path || '')).filter(Boolean);
        const missing = requested.filter(path => !fs.existsSync(path));
        if (missing.length) {
          throw new Error(`MediaFileMissing: ${missing.map(filePath => path.basename(filePath)).join(', ')}`);
        }
        const exist = requested.filter(path => fs.existsSync(path));
        const isVid = p => /\.(mp4|mov|avi|webm|m4v)$/i.test(p);
        const video = exist.find(isVid);
        const files = video ? [video] : exist.filter(p => !isVid(p)).slice(0, 4);
        if (!files.length) throw new Error(`MediaUnsupported: no supported media files for @${account.username}`);

        hasVideo = !!video;
        attachedFiles = files;
        const input = page.locator(SEL.fileInput).first();
        if (await input.count().catch(() => 0) < 1) {
          throw new Error(`MediaInputMissing: X compose did not expose the upload input for @${account.username}`);
        }
        const previews = page.locator(SEL.mediaPreview);
        mediaPreviewBaseline = await previews.count().catch(() => 0);
        await input.setInputFiles(files);

        // Do not publish text-only if X rejected or silently ignored the file.
        const previewTimeout = hasVideo ? 120_000 : 45_000;
        await page.waitForFunction(({ selector, baseline }) => {
          const nodes = [...document.querySelectorAll(selector)];
          return nodes.length > baseline && nodes.slice(baseline).some(node => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          });
        }, { selector:SEL.mediaPreview, baseline:mediaPreviewBaseline }, { timeout:previewTimeout }).catch(() => {
          throw new Error(`MediaPreviewMissing: X did not attach ${files.length} ${hasVideo ? 'video' : 'image'} file(s)`);
        });
        logger.info(`[Action] Media attached: ${files.length} ${hasVideo ? 'video' : 'image'} file(s) @${account.username}`);

        // الفيديو يحتاج وقت معالجة أطول قبل أن يُفعّل زر النشر.
        if (hasVideo) {
          await sleep(2500, 4000);
        } else {
          await sleep(800, 1400);
        }
      }

      // Submit — use Locator for reliable enabled check
      // Try tweetButtonInline first (inside compose modal), fallback to tweetButton
      const submitLocator = page.locator(`${SEL.tweetBtnInline}, ${SEL.tweetBtn}`).first();

      // انتظر تفعيل الزر — الفيديو يحتاج وقتاً أطول حتى يكتمل رفعه/معالجته
      let btnEnabled = false;
      const maxAttempts = hasVideo ? 75 : 8; // ~75s للفيديو، ~8s للصور
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

      if (attachedFiles.length) {
        const previewCount = await page.locator(SEL.mediaPreview).count().catch(() => 0);
        const stillAttached = previewCount > mediaPreviewBaseline;
        if (!stillAttached) {
          throw new Error(`MediaAttachmentLost: media disappeared before submit for @${account.username}`);
        }
      }

      // The compose URL usually does not change after posting. Capture X's
      // CreateTweet response instead; a click alone is not proof of success.
      const createTweetResponse = page.waitForResponse(response => {
        const url = response.url();
        return response.request().method() === 'POST' && /\/CreateTweet(?:\?|$)/i.test(url);
      }, { timeout: 20_000 }).catch(() => null);
      await submitLocator.evaluate(el => el.click());
      const response = await createTweetResponse;
      await sleep(1200, 2200);

      let tweetId = null;
      if (response) {
        const payload = await response.json().catch(() => null);
        tweetId = extractCreatedTweetId(payload);
        if (!response.ok() || (!tweetId && payload?.errors?.length)) {
          const detail = payload?.errors?.map(error => error.message || error.code).filter(Boolean).join('; ');
          throw new Error(`CreateTweetRejected: HTTP ${response.status()}${detail ? ` — ${detail}` : ''}`);
        }
      }

      // Defensive fallback for UI/API variants where the network response is
      // hidden: verify an exact, freshly-created post on the account profile.
      if (!tweetId) tweetId = await this._findRecentPublishedTweet(page, account, content.text);
      if (!tweetId) {
        const error = new Error(`TweetConfirmationUnknown: @${account.username} — submit clicked but no new tweet could be verified`);
        error.code = 'TWEET_CONFIRMATION_UNKNOWN';
        throw error;
      }
      const tweetUrl = `https://x.com/${account.username}/status/${tweetId}`;

      await account.bump('post').catch(swallow('bump:post', 'warn'));
      await Browser.persistSession(account);
      await log(account._id, 'publish', 'tweet_posted', 'success', { tweetId, tweetUrl, verified:true, ms: Date.now()-t0 });
      if (global.io) global.io.emit('action:done', { type:'tweet', account:account.username, tweetId });

      logger.info(`[Action] Tweet posted+verified: @${account.username} ${tweetId} (${Date.now()-t0}ms)`);
      return { success:true, verified:true, tweetId, tweetUrl };

    } catch (e) {
      if (!/cap reached/i.test(e.message)) {
        await this._captureDebug(page, account, 'tweet-fail', { navStatus, error: e.message.slice(0, 160) }).catch(() => {});
      }
      await log(account._id, 'publish', 'tweet_failed', 'failure', { error:e.message });
      logger.error(`[Action] Tweet failed @${account.username}: ${e.message}`);
      throw e;
    } finally {
      await page.close().catch(() => {});
    }
  },

  async _findRecentPublishedTweet(page, account, expectedText) {
    try {
      await this._navigate(page, `https://x.com/${account.username}`, account);
      const ready = await dom.present(page, 'article', { timeout: 20_000, state: 'visible' });
      if (!ready) return null;
      await sleep(900, 1500);
      return await page.locator('article').evaluateAll((articles, args) => {
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const expected = normalize(args.expectedText);
        const handle = String(args.username || '').toLowerCase();
        const now = Date.now();
        for (const article of articles.slice(0, 8)) {
          const text = normalize(article.querySelector('[data-testid="tweetText"]')?.textContent);
          if (!text || text !== expected) continue;
          const time = article.querySelector('time')?.getAttribute('datetime');
          const timestamp = time ? Date.parse(time) : NaN;
          if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 10 * 60_000) continue;
          for (const link of article.querySelectorAll('a[href*="/status/"]')) {
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/([^/]+)\/status\/(\d+)/i);
            if (match && match[1].toLowerCase() === handle) return match[2];
          }
        }
        return null;
      }, { expectedText, username: account.username });
    } catch (error) {
      logger.warn(`[Action] Tweet verification fallback @${account.username}: ${error.message}`);
      return null;
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
  // ── تنقّل محميّ بقاطع الدائرة ─────────────────────────────────
  // يفحص القاطع قبل (يتخطّى بروكسي في تبريد)، ثم يسجّل نجاح/فشل البروكسي بعد.
  async _navigate(page, url, account) {
    ProxyBreaker.assert(account); // SKIP لو الدائرة مفتوحة
    try {
      const r = await dom.navigate(page, url);
      ProxyBreaker.record(account._id, true);
      return r;
    } catch (e) {
      // فشل بروكسي/شبكة فقط يُحتسب على القاطع (لا أخطاء التطبيق)
      if (/^(ProxyError|RateLimited|NavError)/.test(e.message)) ProxyBreaker.record(account._id, false);
      throw e;
    }
  },

  async _openTweetComposer(page, account) {
    let navResp = null;
    try {
      navResp = await this._navigate(page, 'https://x.com/home', account);
    } catch (error) {
      // Chromium قد يبلغ عن انتهاء مهلة DOMContentLoaded بينما React بدأ
      // فعلياً بالرسم. نكمل فحص DOM فقط لهذه الحالة، ولا نبتلع أخطاء الشبكة.
      if (!/Timeout.*(?:goto|navigation)|Timeout \d+ms exceeded/i.test(error.message)) throw error;
      logger.warn(`[Action] @${account.username} — home navigation timed out; checking rendered DOM...`);
    }

    if (await dom.present(page, Sel.compose.editor, { timeout:30_000, state:'visible' })) return navResp;
    await this._checkNotRedirected(page, account);

    const composeLink = page.locator('a[href="/compose/post"]');
    if (await composeLink.count().catch(() => 0)) {
      await composeLink.first().evaluate(element => element.click()).catch(() => {});
      if (await dom.present(page, Sel.compose.editor, { timeout:25_000, state:'visible' })) return navResp;
    }

    logger.warn(`[Action] @${account.username} — compose DOM slow; reloading home once...`);
    await page.goto('https://x.com/home', { waitUntil:'domcontentloaded', timeout:60_000 }).catch(() => {});
    await this._checkNotRedirected(page, account);
    if (await dom.present(page, Sel.compose.editor, { timeout:40_000, state:'visible' })) return navResp;

    const retryLink = page.locator('a[href="/compose/post"]');
    if (await retryLink.count().catch(() => 0)) {
      await retryLink.first().evaluate(element => element.click()).catch(() => {});
      if (await dom.present(page, Sel.compose.editor, { timeout:25_000, state:'visible' })) return navResp;
    }
    return navResp;
  },

  // ── النموذج المرجعي للعقد المتين ─────────────────────────────
  // جاهزية مؤكّدة → idempotent → فعل متحقّق من DOM → خطأ صريح + تشخيص.
  // bump هنا فقط (عند نجاح متحقّق) — الـ processor لا يضاعفه.
  async like(account, tweetId) {
    if (!account.canDo('like')) throw new Error(`@${account.username}: daily like cap reached`);
    const page = await this._readyPage(account);
    let navStatus = 'n/a';
    try {
      // navigate يصنّف فشل البروكسي/الشبكة + status (200/403/429) بوضوح بدل بلعه
      const navResp = await this._navigate(page, `https://x.com/i/status/${tweetId}`, account);
      navStatus = navResp ? navResp.status() : 'no-resp';

      // ① الصفحة جاهزة فعلاً؟ (وإلا خطأ واضح: auth_required / ProxyError / EmptyDocument — لا timeout غامض)
      await dom.assertTweetReady(page, Sel, account);
      await sleep(600, 1000);

      // ② مُسبقاً معجَب؟ (idempotent، متحقّق من حالة الـ DOM)
      if (await dom.present(page, Sel.tweet.liked, { timeout: 1500 })) {
        return { success: true, alreadyLiked: true };
      }

      // ③ اضغط لايك وتحقّق أنه صار "معجَب" فعلاً (يظهر زر unlike)
      await dom.clickVerified(page, {
        name:   'like',
        target: Sel.tweet.like,
        verify: Sel.tweet.liked,
      });

      // اللايك تمّ وتُحقّق منه — فشل حفظ العدّاد يُسجَّل بصوت ولا يُفشّل العملية
      await account.bump('like').catch(swallow('bump:like', 'warn'));
      await log(account._id, 'engage', 'like', 'success', { tweetId, verified: true });
      return { success: true, verified: true };
    } catch (e) {
      // تشخيص على الأخطاء الحقيقية فقط (لا على تجاوز السقف)
      if (!/cap reached/i.test(e.message)) {
        await this._captureDebug(page, account, 'like-fail', { navStatus, error: e.message.slice(0, 160) }).catch(() => {});
      }
      await log(account._id, 'engage', 'like_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

  // ── Retweet ───────────────────────────────────────────────────
  async retweet(account, tweetId) {
    if (!account.canDo('repost')) throw new Error(`@${account.username}: daily retweet cap reached`);
    const page = await this._readyPage(account);
    let navStatus = 'n/a';
    try {
      const r = await this._navigate(page, `https://x.com/i/status/${tweetId}`, account);
      navStatus = r ? r.status() : 'no-resp';
      await dom.assertTweetReady(page, Sel, account);
      await sleep(600, 1000);

      // مُسبقاً مُعاد نشره؟ (idempotent)
      if (await dom.present(page, Sel.tweet.retweeted, { timeout: 1500 })) {
        return { success: true, alreadyRetweeted: true };
      }

      // اضغط ريتويت → انتظر حوار التأكيد → أكّد
      const rt = await dom.resolve(page, 'retweet', Sel.tweet.retweet);
      await rt.evaluate(el => el.click());
      const confirm = await dom.resolve(page, 'retweetConfirm', Sel.tweet.retweetConfirm, { timeout: 10_000 });
      await sleep(400, 700);
      await confirm.evaluate(el => el.click());

      // تحقّق أنه صار "مُعاد نشره" فعلاً
      if (!await dom.present(page, Sel.tweet.retweeted, { timeout: 8000 })) {
        throw new Error(`ActionUnverified[retweet]: لم يتحوّل لحالة "أُعيد نشره"`);
      }

      await account.bump('repost').catch(swallow('bump:repost', 'warn'));
      await log(account._id, 'engage', 'retweet', 'success', { tweetId, verified: true });
      return { success: true, verified: true };
    } catch (e) {
      if (!/cap reached/i.test(e.message)) {
        await this._captureDebug(page, account, 'retweet-fail', { navStatus, error: e.message.slice(0, 160) }).catch(() => {});
      }
      await log(account._id, 'engage', 'retweet_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

    // ── Reply ─────────────────────────────────────────────────────
  async reply(account, tweetId, text, mediaLocalPaths = []) {
    if (!account.canDo('reply')) throw new Error(`@${account.username}: daily reply cap reached`);
    const page = await this._readyPage(account);
    let navStatus = 'n/a';
    try {
      const r = await this._navigate(page, `https://x.com/i/status/${tweetId}`, account);
      navStatus = r ? r.status() : 'no-resp';
      await dom.assertTweetReady(page, Sel, account);
      await sleep(800, 1200);

      // افتح مُحرّر الرد
      const replyBtn = await dom.resolve(page, 'reply', Sel.tweet.reply);
      await replyBtn.evaluate(el => el.click());
      await dom.resolve(page, 'composeEditor', Sel.compose.editor, { timeout: 25_000 });
      await sleep(500, 800);

      // اكتب في آخر مُحرّر (المودال، لا صندوق الرد العلوي)
      const editor = page.locator(Sel.compose.editor[0]).last();
      const before = await page.locator(Sel.compose.editor[0]).count();
      await editor.evaluate(el => el.focus());
      await editor.type(text, { delay: 40 });
      await sleep(700, 1100);

      if (mediaLocalPaths?.length) {
        const fi = await page.$('input[type="file"][accept*="image"]').catch(() => null);
        if (fi) { await fi.setInputFiles(mediaLocalPaths); await sleep(2000, 3000); }
      }

      // أرسِل
      const send = await dom.resolve(page, 'replySubmit', Sel.compose.submitInline, { timeout: 15_000 });
      await send.evaluate(el => el.click());

      // تحقّق أن المُحرّر أُغلق (عدد المُحرّرات نقص) = الرد أُرسل فعلاً
      const sent = await page.waitForFunction(
        ({ sel, n }) => document.querySelectorAll(sel).length < n,
        { sel: Sel.compose.editor[0], n: before }, { timeout: 12_000 },
      ).then(() => true).catch(() => false);
      if (!sent) throw new Error(`ActionUnverified[reply]: المُحرّر لم يُغلق — الرد غالباً لم يُرسل`);

      await account.bump('reply').catch(swallow('bump:reply', 'warn'));
      await log(account._id, 'engage', 'reply', 'success', { tweetId, verified: true });
      return { success: true, verified: true };
    } catch (e) {
      if (!/cap reached/i.test(e.message)) {
        await this._captureDebug(page, account, 'reply-fail', { navStatus, error: e.message.slice(0, 160) }).catch(() => {});
      }
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
    let navStatus = 'n/a';
    try {
      const cleanHandle = targetHandle.replace(/^@+/, '');
      // navigate يصنّف فشل البروكسي/الشبكة + status بوضوح بدل بلعه
      const r = await this._navigate(page, `https://x.com/${cleanHandle}`, account);
      navStatus = r ? r.status() : 'no-resp';
      await sleep(2000, 3000);
      await this._checkNotRedirected(page, account);

      // تحقق من Cloudflare
      const currentUrl = page.url();
      if (currentUrl.includes('/account/access') || currentUrl.includes('Just a moment')) {
        account.status = 'checkpoint';
        account.lastCheckedAt = new Date();
        await account.save().catch(swallow('save:status', 'warn'));
        throw new Error(`SKIP:@${account.username} — checkpoint`);
      }

      // تجاوز تحذير "This account is temporarily restricted"
      // نستخدم waitForSelector بدل $ لأن الصفحة ممكن ما تحملت كامل
      const warningBtn = await page.waitForSelector(
        'button:has-text("Yes, view profile"), button:has-text("Yes, view")',
        { state: 'visible', timeout: 5_000 }
      ).catch(() => null);
      if (warningBtn) {
        logger.info(`[Follow] @${account.username} — Bypassing restricted warning`);
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
        logger.info(`[Follow] @${account.username} — Error page, reloading......`);
        // reload بـ networkidle يضمن تحميل React كامل
        await page.reload({ waitUntil: 'networkidle', timeout: 40_000 }).catch(() => {});
        await sleep(2000, 3000);
        await this._checkNotRedirected(page, account);
        // تحقق مرة ثانية
        const stillBroken = await page.evaluate(() =>
          [...document.querySelectorAll('button')].some(b => /try again/i.test(b.textContent.trim()))
        ).catch(() => false);
        if (stillBroken) throw new Error(`SKIP:@${account.username} — X refused to load the page`);
      }

      // انتظر تحميل المحتوى — X.com SPA تحتاج وقت بعد domcontentloaded
      await sleep(1500, 2500);

      // انتظر userActions أو primaryColumn
      await Promise.race([
        page.waitForSelector('[data-testid="userActions"]',       { timeout: 15_000 }),
        page.waitForSelector('[data-testid="placementTracking"]', { timeout: 15_000 }),
        page.waitForSelector('[data-testid="primaryColumn"]',     { timeout: 15_000 }),
      ]).catch(() => {});

      // انتظر follow button نفسه يظهر (بدل sleep ثابت)
      // X SPA يحمّل userActions أولاً ثم يضيف الأزرار
      await Promise.race([
        page.waitForSelector('[data-testid$="-follow"]:not([data-testid$="-unfollow"])', { timeout: 5_000 }),
        page.waitForSelector('[aria-label^="Follow @"]',   { timeout: 5_000 }),
        page.waitForSelector('[data-testid$="-unfollow"]', { timeout: 5_000 }), // already following
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
          // تحقق إذا already following
          const already = document.querySelector('[data-testid$="-unfollow"],[aria-label^="Following @"],[aria-label^="Unfollow @"]');
          if (already) return 'already';

          // بحث في كل الأزرار المرئية داخل userActions
          const zone = document.querySelector('[data-testid="userActions"]') || document.body;
          const btns = [...zone.querySelectorAll('button,[role="button"]')];

          // follow button في X.com: style يشمل background-color أخضر أو له data-testid
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
        // "See new posts" = already following
        const alreadyIndicators = ['See new posts', 'New posts', 'Show new posts'];
        const isAlready = pageInfo.btns?.some(b => alreadyIndicators.some(i => b.includes(i)));
        if (isAlready) {
          logger.info(`[Follow] @${account.username} — Already following @${targetHandle} (See new posts)`);
          return { success: true, alreadyFollowing: true };
        }
        throw new Error('لم يتم إيجاد follow button');
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
      await account.bump('follow').catch(swallow('bump:follow', 'warn'));
      await log(account._id, 'engage', 'follow', 'success', { target: targetHandle });
      return { success: true };
    } catch (e) {
      logger.error(`[Follow] @${account.username} → @${targetHandle} ERROR: ${e.message}`);
      if (!/cap reached/i.test(e.message) && !e.message.startsWith('SKIP:')) {
        await this._captureDebug(page, account, 'follow-fail', { navStatus, error: e.message.slice(0, 160) }).catch(() => {});
      }
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
  async updateProfile(account, updates = {}, { isCancelled } = {}) {
    const fs = require('fs');
    const throwIfCancelled = () => {
      if (isCancelled?.()) throw new Error(`CANCELLED:@${account.username} — profile update stopped by user`);
    };

    // نستخدم getPage مباشرة بعد API verify — بدون _readyPage لتجنب race condition
    // _readyPage تضيف page.on('close')→persistSession اللي يتعارض مع closeContext
    throwIfCancelled();
    await AuthSvc.ensureSession(account);
    throwIfCancelled();
    const page = await Browser.getPage(account);

    // ── جمع تشخيصي: أخطاء console وفشل الشبكة (يُدمج في تقرير الفشل) ──
    const _consoleErrs = [];
    const _failedReqs  = [];
    page.on('console', m => { if (m.type() === 'error') _consoleErrs.push(m.text().slice(0, 200)); });
    page.on('pageerror', e => _consoleErrs.push(`pageerror: ${(e.message || e).toString().slice(0, 200)}`));
    page.on('response', r => {
      const s = r.status();
      if (s >= 400) { const u = r.url(); if (/\.js|\/api\/|graphql|settings/i.test(u)) _failedReqs.push(`${s} ${u.slice(0, 120)}`); }
    });

    try {
      const profileFormSelector = [
        'input[name="displayName"]',
        'textarea[name="description"]',
        '[data-testid="Profile_Save_Button"]',
      ].join(',');
      const waitForProfileForm = (timeout = 20_000) => page.waitForFunction(selector =>
        [...document.querySelectorAll(selector)].some(el => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        }), profileFormSelector, { timeout }).then(() => true).catch(() => false);

      const openSettingsDirectly = async () => {
        await page.goto('https://x.com/settings/profile', {
          waitUntil: 'domcontentloaded',
          timeout: 40_000,
        }).catch(() => {});
        throwIfCancelled();
        await sleep(500, 800);
        await this._dismissPopups(page);
        await this._checkNotRedirected(page, account);
      };

      // المسار السريع: الحسابات السليمة لا تحتاج فتح home قبل كل تحديث.
      await openSettingsDirectly();
      let formReady = await waitForProfileForm(10_000);

      if (!formReady) {
        // الإقلاع البارد لبعض جلسات X يعرض shell فارغًا عند فتح الإعدادات
        // مباشرة. في هذه الحالة فقط نُحمّي الجلسة عبر home ثم نعيد المحاولة.
        logger.info(`[Action] @${account.username} — Direct settings load was slow, warming session through home...`);
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});
        throwIfCancelled();
        await this._dismissPopups(page);
        await this._checkNotRedirected(page, account);
        await page.waitForSelector(
          '[data-testid="AppTabBar_Home_Link"], [data-testid="SideNav_AccountSwitcher_Button"], [data-testid="primaryColumn"]',
          { timeout: 12_000 },
        ).catch(() => {});
        await openSettingsDirectly();
        formReady = await waitForProfileForm();
      }

      if (!formReady) {
        // الصفحة لم تحمّل الفورم — reload مع انتظار 'load' (تهيئة الـ SPA كاملة)
        logger.info(`[Action] @${account.username} — Settings form timeout, reloading...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});
        // امنح React وقتاً ليُهيّئ؛ networkidle غير مناسب لاتصالات X المستمرة.
        await sleep(2000, 3000);
        await this._dismissPopups(page);
        await this._checkNotRedirected(page, account);

        formReady = await waitForProfileForm();

        if (!formReady) {
          // بعض الجلسات تعيد /settings/profile إلى /home. افتح صفحة الحساب
          // واضغط Edit profile من داخل واجهة X كمسار احتياطي.
          logger.info(`[Action] @${account.username} — Opening profile editor through profile page...`);
          await page.goto(`https://x.com/${account.username}`, { waitUntil: 'domcontentloaded', timeout: 40_000 }).catch(() => {});
          await this._dismissPopups(page);
          await this._checkNotRedirected(page, account);
          const editBtn = page.locator('[data-testid="editProfileButton"]').first();
          if (await editBtn.isVisible().catch(() => false)) {
            await editBtn.evaluate(el => el.click()).catch(() => {});
            formReady = await waitForProfileForm();
          }
        }

        if (!formReady) {
          // التقط لقطة + HTML + console/network لتشخيص ما عرضه X فعلاً
          const diag = await this._captureDebug(page, account, 'settings-form-fail', {
            consoleErrs: _consoleErrs.slice(0, 5),
            failedReqs:  _failedReqs.slice(0, 5),
          }).catch(() => ({}));

          // لو شفنا 403 على API المصادقة (Viewer/GetUserClaims) → الجلسة منتهية فعلاً
          // علّم الحساب auth_required واحذف الجلسة الميتة — يخلّي الحسابات الفاسدة واضحة للمستخدم
          const authBlocked = _failedReqs.some(r => /^403\b/.test(r) && /Viewer|GetUserClaims|graphql/i.test(r));
          if (authBlocked) {
            account.status        = 'auth_required';
            account.lastCheckedAt = new Date();
            await account.save().catch(swallow('save:status', 'warn'));
            const Vault = require('./vault.service');
            await Vault.deleteSession(account._id.toString()).catch(() => {});
            logger.warn(`[Action] @${account.username} — Auth expired (403 on API), marked auth_required, session deleted`);
            throw new Error(`SKIP:@${account.username} — auth_required (الجلسة منتهية، يحتاج تسجيل دخول جديد)`);
          }

          throw new Error(`SKIP:@${account.username} — settings/profile failed to load (url=${diag.url || page.url()})`);
        }
      }

      logger.info(`[Action] @${account.username} — ✓ settings/profile Ready`);
      await sleep(500, 800);

      const applyImageCrop = async label => {
        const applyBtn = page.locator('[data-testid="applyButton"]:visible').last();
        await applyBtn.waitFor({ state: 'visible', timeout: 20_000 });
        await applyBtn.click({ force: true, timeout: 15_000 });

        let closed = await applyBtn.waitFor({ state: 'hidden', timeout: 30_000 })
          .then(() => true).catch(() => false);
        if (!closed) {
          // Retry with a complete pointer/mouse sequence for React crop dialogs.
          await applyBtn.evaluate(el => {
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
              el.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, pointerId: 1 }));
            }
          }).catch(() => {});
          closed = await applyBtn.waitFor({ state: 'hidden', timeout: 20_000 })
            .then(() => true).catch(() => false);
        }
        if (!closed) throw new Error(`${label} crop dialog did not close after Apply`);
        await sleep(800, 1200);
      };

      // ── رفع الصورة الشخصية ──────────────────────────────
      if (updates.avatarPath && fs.existsSync(updates.avatarPath)) {
        throwIfCancelled();
        const avatarInputHandle = await page.evaluateHandle(() => {
          const inputs = document.querySelectorAll('input[data-testid="fileInput"]');
          return inputs[1] || null; // الثاني للأفاتار في X.com
        });
        const avatarInput = avatarInputHandle?.asElement?.();
        if (!avatarInput) throw new Error('Avatar file input was not found in the profile editor');
        await avatarInput.setInputFiles(updates.avatarPath);
        await applyImageCrop('Avatar');
        logger.info(`[Action] @${account.username} — ✓ Avatar uploaded`);
      } else if (updates.avatarPath) {
        throw new Error(`Avatar path not found: ${updates.avatarPath}`);
      }

      // ── رفع البانر ──────────────────────────────────────
      if (updates.bannerPath && fs.existsSync(updates.bannerPath)) {
        throwIfCancelled();
        await sleep(1000, 1500);
        const bannerInputHandle = await page.evaluateHandle(() => {
          const inputs = document.querySelectorAll('input[data-testid="fileInput"]');
          return inputs[0] || null; // الأول للبانر في X.com
        });
        const bannerInput = bannerInputHandle?.asElement?.();
        if (!bannerInput) throw new Error('Banner file input was not found in the profile editor');
        await bannerInput.setInputFiles(updates.bannerPath);
        await applyImageCrop('Banner');
        logger.info(`[Action] @${account.username} — ✓ Banner uploaded`);
      } else if (updates.bannerPath) {
        throw new Error(`Banner path not found: ${updates.bannerPath}`);
      }

      // ── تحديث النصوص ────────────────────────────────────
      // React inputs تحتاج nativeInputValueSetter لإطلاق onChange صحيح
      const fillReact = async (selector, value) => {
        throwIfCancelled();
        const loc = page.locator(selector).first();
        const count = await loc.count().catch(() => 0);
        if (!count) { logger.warn(`[Action] @${account.username} — Field not found: ${selector}`); return false; }
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        const nextValue = String(value);
        // fill لا يحتاج pointer click، لذلك لا يتأثر بطبقة modal أثناء زوالها.
        await loc.fill(nextValue, { timeout: 15_000 }).catch(async () => {
          // fallback مباشر يدعم React controlled inputs بدون pointer events.
          await loc.evaluate((el, val) => {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, nextValue);
        });
        const actual = await loc.inputValue().catch(() => '');
        if (actual !== nextValue) {
          throw new Error(`Field value did not update: ${selector}`);
        }
        await sleep(400, 600);
        logger.info(`[Action] @${account.username} — ✓ Field filled: ${selector.match(/name="([^"]+)"/)?.[1] || selector}`);
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
      throwIfCancelled();
      const saved = await (async () => {
        // انتظر زر الحفظ
        const saveBtn = page.locator('[data-testid="Profile_Save_Button"]');
        try {
          await saveBtn.waitFor({ state: 'visible', timeout: 10_000 });
          await saveBtn.scrollIntoViewIfNeeded().catch(() => {});
          await sleep(300, 500);
          const saveResponse = page.waitForResponse(response =>
            /update_profile|UpdateProfile/i.test(response.url()),
            { timeout: 30_000 },
          ).then(response => response.ok()).catch(() => null);
          // force bypasses transient overlays; success is verified below.
          await saveBtn.click({ force: true, timeout: 15_000 });
          const apiSaved = await saveResponse;
          const formClosed = await saveBtn.waitFor({ state: 'hidden', timeout: 15_000 })
            .then(() => true).catch(() => false);
          if (apiSaved === false) throw new Error('X rejected the profile update request');
          if (apiSaved !== true && !formClosed) throw new Error('Profile save was not confirmed by X');
          logger.info(`[Action] @${account.username} — ✓ Saved (verified)`);
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
        if (ok) {
          const closed = await page.locator('[data-testid="Profile_Save_Button"]').waitFor({ state: 'hidden', timeout: 15_000 })
            .then(() => true).catch(() => false);
          if (closed) { logger.info(`[Action] @${account.username} — ✓ Saved (dispatch verified)`); return true; }
        }
        logger.warn(`[Action] @${account.username} — Save button not found`);
        return false;
      })();

      if (!saved) throw new Error(`Profile save was not confirmed for @${account.username}`);
      await sleep(3000, 4000);

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
    const apiProfile = await AuthSvc.fetchOwnProfile(account).catch(() => null);
    if (apiProfile) {
      const currentProfile = account.profile?.toObject?.() || account.profile || {};
      account.profile = {
        ...currentProfile,
        displayName: apiProfile.displayName,
        bio: apiProfile.bio,
        location: apiProfile.location,
        website: apiProfile.website,
        avatarUrl: apiProfile.avatarUrl || currentProfile.avatarUrl || '',
        followersCount: apiProfile.followersCount,
        followingCount: apiProfile.followingCount,
        tweetsCount: apiProfile.tweetsCount,
        lastSyncedAt: new Date(),
      };
      await account.save();
      logger.info(`[ProfileSync] @${account.username}: synced via credentials API${apiProfile.avatarUrl ? ' with avatar' : ''}`);
      return account.profile;
    }

    logger.warn(`[ProfileSync] @${account.username}: credentials API unavailable; falling back to profile DOM`);
    const page = await this._readyPage(account);
    try {
      const profileUrl = `https://x.com/${account.username}`;
      const waitForProfile = () => page.waitForSelector('[data-testid="UserName"]', { timeout:30_000 })
        .then(() => true).catch(() => false);
      await page.goto(profileUrl, { waitUntil:'domcontentloaded', timeout:60_000 });
      await this._checkNotRedirected(page, account);
      let profileReady = await waitForProfile();
      if (!profileReady) {
        logger.warn(`[ProfileSync] @${account.username}: profile DOM slow; reloading once...`);
        await page.reload({ waitUntil:'domcontentloaded', timeout:60_000 }).catch(() => {});
        await this._checkNotRedirected(page, account);
        profileReady = await waitForProfile();
      }
      if (!profileReady) {
        throw new Error(`Profile page did not load for @${account.username} (url=${page.url()})`);
      }
      const parseCount = s => {
        if (!s) return null;
        const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
        const normalized = String(s)
          .replace(/[٠-٩]/g, digit => arabicDigits.indexOf(digit))
          .replace(/[٬,]/g, '')
          .replace(/٫/g, '.');
        const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*(K|M|B|ألف|آلاف|مليون|مليار)?/i);
        if (!match) return null;
        const multipliers = { k:1e3, m:1e6, b:1e9, 'ألف':1e3, 'آلاف':1e3, 'مليون':1e6, 'مليار':1e9 };
        return Math.round(parseFloat(match[1]) * (multipliers[(match[2] || '').toLowerCase()] || 1));
      };
      const data = await page.evaluate(username => {
        const primary = document.querySelector('[data-testid="primaryColumn"]') || document;
        const nameHost = primary.querySelector('[data-testid="UserName"]');
        const nameParts = [...(nameHost?.querySelectorAll('span') || [])]
          .map(element => element.textContent?.trim()).filter(Boolean);
        const displayName = nameParts.find(text => !text.startsWith('@') && !/posts?|منشور|تغريدة/i.test(text)) || '';
        const anchorText = suffixes => {
          const links = [...primary.querySelectorAll('a[href]')];
          const link = links.find(element => suffixes.some(suffix => element.getAttribute('href')?.endsWith(suffix)));
          return link?.textContent?.trim() || '';
        };
        const avatar = primary.querySelector('[data-testid^="UserAvatar-Container-"] img[src*="profile_images"]')
          || primary.querySelector('img[src*="profile_images"]');
        return {
          displayName,
          bio: primary.querySelector('[data-testid="UserDescription"]')?.textContent?.trim() || '',
          followers: anchorText(['/verified_followers', '/followers']),
          following: anchorText(['/following']),
          tweets: nameParts.find(text => /posts?|منشور|تغريدة/i.test(text)) || '',
          avatarUrl: avatar?.currentSrc || avatar?.src || '',
          location: primary.querySelector('[data-testid="UserLocation"]')?.textContent?.trim() || '',
        };
      }, account.username).catch(() => ({}));
      const currentProfile = account.profile?.toObject?.() || account.profile || {};
      const followersCount = parseCount(data.followers);
      const followingCount = parseCount(data.following);
      const tweetsCount = parseCount(data.tweets);
      account.profile = {
        ...currentProfile,
        displayName: data.displayName || currentProfile.displayName || account.username,
        bio: data.bio ?? currentProfile.bio ?? '',
        location: data.location ?? currentProfile.location ?? '',
        avatarUrl: data.avatarUrl
          ? (data.avatarUrl.includes('/profile_images/') ? data.avatarUrl.replace(/_normal(?=\.[a-z]+(?:\?|$))/i, '_400x400') : data.avatarUrl)
          : (currentProfile.avatarUrl || ''),
        followersCount: followersCount ?? currentProfile.followersCount ?? 0,
        followingCount: followingCount ?? currentProfile.followingCount ?? 0,
        tweetsCount: tweetsCount ?? currentProfile.tweetsCount ?? 0,
        lastSyncedAt: new Date(),
      };
      await account.save();
      return account.profile;
    } finally { await page.close().catch(()=>{}); }
  },

  // ── Helpers ───────────────────────────────────────────────────
  async _checkNotRedirected(page, account) {
    const url = page.url();
    if (url.includes('/i/flow/login') || url.includes('/account/access') || url.includes('/i/flow/password_reset')) {
      account.status        = 'auth_required';
      account.lastCheckedAt = new Date();
      await account.save().catch(swallow('save:status', 'warn'));
      // احذف الجلسة المحفوظة — انتهت صلاحيتها
      const Vault = require('./vault.service');
      await Vault.deleteSession(account._id.toString()).catch(() => {});
      logger.warn(`[Action] @${account.username} — Redirected to login, session deleted`);
      throw new Error(`SKIP:@${account.username} — auth_required`);
    }
    if (url.includes('/suspended')) {
      account.status        = 'suspended';
      account.lastCheckedAt = new Date();
      await account.save().catch(swallow('save:status', 'warn'));
      throw new Error(`SKIP:@${account.username} — suspended`);
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
    // logger.info(`[IP] @${account.username} — proxy: ${hasProxy ? '✅ ' + (account.network.proxyUrl.split('@')[1] || '') : '❌ no proxy'}`);

    // لا نغلق الصفحة تلقائياً — _checkNotRedirected يتولى الأمر

    // كشف "Try again" و "Yes, view profile" بعد أي تنقل
    page.on('load', async () => {
      try {
        // Bypassing restricted warning تلقائياً
        const viewBtn = await page.$('button:has-text("Yes, view profile"), button:has-text("Yes, view")').catch(() => null);
        if (viewBtn) {
          await viewBtn.click().catch(() => {});
          await sleep(1000, 1500);
        }
        // Reloading on error page
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


  // ── Bookmark ─────────────────────────────────────────────────
  async bookmark(account, tweetId) {
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // scroll to trigger full render
      await sleep(1000, 1500);
      await page.mouse.wheel(0, 200);
      await sleep(500, 800);
      await page.mouse.wheel(0, -200);
      await page.waitForSelector('[data-testid="bookmark"], [data-testid="removeBookmark"]', { timeout: 45_000 });
      await sleep(700, 1200);
      const already = await page.locator('[data-testid="removeBookmark"]').count().catch(() => 0);
      if (already > 0) return { success: true, alreadyBookmarked: true };
      await page.locator('[data-testid="bookmark"]').first().evaluate(el => el.click());
      await sleep(600, 1000);
      await log(account._id, 'engage', 'bookmark', 'success', { tweetId });
      return { success: true };
    } catch(e) {
      await log(account._id, 'engage', 'bookmark_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

  // ── Quote Tweet ───────────────────────────────────────────────
  async quoteTweet(account, tweetId, text) {
    if (!account.canDo('post')) throw new Error(`@${account.username}: daily post cap reached`);
    if (!text?.trim()) throw new Error(`@${account.username}: quote text required`);
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="retweet"], [data-testid="unretweet"]', { timeout: 30_000 });
      await sleep(800, 1300);

      // Click retweet button to open menu
      await page.locator('[data-testid="retweet"]').first().evaluate(el => el.click());
      await page.waitForSelector('a[href="/compose/post"][role="menuitem"]', { timeout: 8_000 });
      await sleep(400, 700);

      // Click Quote
      await page.locator('a[href="/compose/post"][role="menuitem"]').first().evaluate(el => el.click());
      await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10_000 });
      await sleep(600, 1000);

      // Type text human-like
      await page.locator('[data-testid="tweetTextarea_0"]').first().click();
      await sleep(300, 600);
      await this._humanType(page, text.slice(0, 280));
      await sleep(800, 1500);

      // Post
      await page.locator('[data-testid="tweetButtonInline"]').first().evaluate(el => el.click());
      await sleep(1500, 2500);

      // Extract tweetId from URL if redirected
      const url = page.url();
      const m   = url.match(/status\/(\d+)/);
      const quoteTweetId = m ? m[1] : null;

      await account.bump('post').catch(swallow('bump:post', 'warn'));
      await log(account._id, 'engage', 'quote_tweet', 'success', { tweetId, quoteTweetId });
      return { success: true, quoteTweetId, quoteTweetUrl: quoteTweetId ? `https://x.com/${account.username}/status/${quoteTweetId}` : null };
    } catch(e) {
      await log(account._id, 'engage', 'quote_tweet_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

  // ── Profile Visit + Dwell ────────────────────────────────────
  async profileVisit(account, targetHandle, dwellSeconds = 8) {
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/${targetHandle}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="UserName"]', { timeout: 20_000 });

      // Human-like dwell: scroll slowly through profile
      const dwell = (dwellSeconds * 1000) + randInt(-1000, 2000);
      const scrollSteps = Math.floor(dwell / 1500);
      for (let i = 0; i < scrollSteps; i++) {
        await page.mouse.wheel(0, randInt(120, 280));
        await sleep(800, 1800);
      }

      await log(account._id, 'engage', 'profile_visit', 'success', { targetHandle, dwellSeconds });
      return { success: true };
    } catch(e) {
      await log(account._id, 'engage', 'profile_visit_failed', 'failure', { targetHandle, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

  // ── Tweet Dwell (view time signal) ───────────────────────────
  async tweetDwell(account, tweetId, dwellSeconds = 12) {
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForSelector('[data-testid="tweetText"], article, [data-testid="cellInnerDiv"]', { timeout: 30_000 });

      // Scroll slowly — simulates reading
      const dwell = (dwellSeconds * 1000) + randInt(-1000, 3000);
      const steps = Math.floor(dwell / 2000);
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, randInt(80, 180));
        await sleep(1200, 2500);
      }
      // Scroll back up (natural behavior)
      await page.mouse.wheel(0, -randInt(200, 400));
      await sleep(500, 900);

      await log(account._id, 'engage', 'tweet_dwell', 'success', { tweetId, dwellSeconds });
      return { success: true };
    } catch(e) {
      await log(account._id, 'engage', 'tweet_dwell_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },

  // ── Share (Copy Link signal) ─────────────────────────────────
  async shareTweet(account, tweetId) {
    const page = await this._readyPage(account);
    try {
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const shareBtn = await page.waitForSelector(
        '[aria-haspopup="menu"][aria-label="Share post"], [aria-haspopup="menu"][aria-label="Share"]',
        { timeout: 30_000 }
      );
      await sleep(700, 1200);
      await shareBtn.evaluate(el => el.click());
      await page.waitForSelector('[data-testid="Dropdown"]', { timeout: 8_000 });
      await sleep(400, 800);

      // Click Copy link
      const copyBtn = page.locator('[data-testid="Dropdown"] [role="menuitem"]').first();
      await copyBtn.evaluate(el => el.click());
      await sleep(600, 1000);

      // Close dropdown if still open
      await page.keyboard.press('Escape').catch(() => {});

      await log(account._id, 'engage', 'share_tweet', 'success', { tweetId });
      return { success: true };
    } catch(e) {
      await log(account._id, 'engage', 'share_tweet_failed', 'failure', { tweetId, error: e.message });
      throw e;
    } finally { await page.close().catch(() => {}); }
  },


  // ── Engage Tweet — single page session for all actions ───────
  // Used by engagement processor to avoid reopening browser per action
  // ── Dismiss X popups (ToS, notifications, etc.) ─────────────
  // ── التقاط تشخيصي عند فشل تحميل صفحة (screenshot + url + title + نص) ──
  // يكتب لـ ./data/debug ويُرجع المعلومات — يجعل الفشل قابلاً للتشخيص بدل SKIP أعمى
  async _captureDebug(page, account, tag, extra = {}) {
    const out = { url: null, title: null, text: null, shot: null, html: null, rootLen: null, htmlLen: null };
    try { out.url   = page.url(); } catch {}
    try { out.title = await page.title().catch(() => null); } catch {}
    try { out.text  = await page.evaluate(() => (document.body?.innerText || '').slice(0, 300)).catch(() => null); } catch {}
    // طول محتوى react-root — 0 يعني الـ SPA لم يرسم شيئاً
    try {
      const info = await page.evaluate(() => {
        const root = document.querySelector('#react-root') || document.querySelector('[data-reactroot]');
        return { rootLen: root ? root.innerHTML.length : -1, htmlLen: document.documentElement.outerHTML.length };
      }).catch(() => null);
      if (info) { out.rootLen = info.rootLen; out.htmlLen = info.htmlLen; }
    } catch {}
    try {
      const fs = require('fs');
      fs.mkdirSync('./data/debug', { recursive: true });
      const stamp = Date.now();
      out.shot = `./data/debug/${tag}-${account.username}-${stamp}.png`;
      await page.screenshot({ path: out.shot, fullPage: true }).catch(() => { out.shot = null; });
      // احفظ الـ HTML الكامل — يكشف رسائل خطأ X أو react-root الفارغ
      out.html = `./data/debug/${tag}-${account.username}-${stamp}.html`;
      const fullHtml = await page.content().catch(() => '');
      fs.writeFileSync(out.html, fullHtml);
    } catch { out.html = null; }
    const ex = Object.keys(extra).length ? ` ${Object.entries(extra).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}` : '';
    logger.warn(`[Action] @${account.username} — DEBUG ${tag}: url=${out.url} title="${out.title || ''}" rootLen=${out.rootLen} htmlLen=${out.htmlLen} text="${(out.text || '').replace(/\s+/g, ' ').trim()}"${ex} shot=${out.shot || 'none'} html=${out.html || 'none'}`);
    return out;
  },

  async _dismissPopups(page) {
    const dismissSelectors = [
      // ToS / Privacy Policy
      'button:has-text("Got it")',
      '[data-testid="confirmationSheetConfirm"]',
      // Ads customization popup (any language)
      'button:has-text("関連性の低い広告を引き続き表示する")',  // Japanese
      'button:has-text("Continue seeing less relevant ads")',   // English
      'button:has-text("متابعة عرض إعلانات")',                // Arabic
      // Notification permission
      'button:has-text("Not now")',
      'button:has-text("Skip")',
      'button:has-text("لاحقاً")',
      // Generic dismiss — any overlay close button
      '[data-testid="app-bar-close"]',
      // "Save post?" draft dialog — click Discard
      'button:has-text("Discard")',
      'button:has-text("تجاهل")',
      'button:has-text("تخلص")',
    ];

    for (const sel of dismissSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await btn.click();
          await page.waitForTimeout(600);
        }
      } catch {}
    }
    // حالة خاصة: "Save post?" dialog — نضغط Discard دائماً
    try {
      const discard = page.locator('button:has-text("Discard"), button:has-text("تجاهل")').first();
      if (await discard.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await discard.click();
        await page.waitForTimeout(600);
      }
    } catch {}
  },

  async engageTweet(account, tweetId, actionList, opts = {}) {
    const { tweetUrl, replyText, quoteText, authorHandle, dwellSeconds = 8, isCancelled } = opts;
    const Browser = require('./browser.service');
    const page = await Browser.getPage(account);

    try {
      // Load tweet ONCE — wait for interactive state
      await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // Wait for tweet actions to render
      await page.waitForSelector('[data-testid="like"],[data-testid="unlike"],[data-testid="retweet"]', { timeout: 30_000 }).catch(() => {});
      await this._dismissPopups(page);
      await sleep(800, 1400);

      const results = [];

      for (const act of actionList) {
        // أوقف فوراً لو أُلغيت العملية وسط التنفيذ
        if (isCancelled?.()) {
          logger.warn(`[EngageTweet] @${account.username} — cancelled, stopping at ${act}`);
          break;
        }
        // تحقق إن الـ page لسا حية قبل كل action
        if (page.isClosed()) {
          logger.warn(`[EngageTweet] @${account.username} — page closed, stopping at ${act}`);
          break;
        }
        try {
          let r;
          switch(act) {

            case 'like': {
              await page.waitForSelector('[data-testid="like"],[data-testid="unlike"]', { timeout: 20_000 });
              const already = await page.locator('[data-testid="unlike"]').count().catch(() => 0);
              if (already) { r = { alreadyLiked: true }; break; }
              await page.locator('[data-testid="like"]').first().evaluate(el => el.click());
              await sleep(600, 1000);
              await account.bump('like').catch(swallow('bump:like', 'warn'));
              await log(account._id, 'engage', 'like', 'success', { tweetId });
              r = { success: true };
              break;
            }

            case 'retweet': {
              await page.waitForSelector('[data-testid="retweet"],[data-testid="unretweet"]', { timeout: 20_000 });
              const already = await page.locator('[data-testid="unretweet"]').count().catch(() => 0);
              if (already) { r = { alreadyRetweeted: true }; break; }
              await page.locator('[data-testid="retweet"]').first().evaluate(el => el.click());
              await page.waitForSelector('[data-testid="retweetConfirm"]', { timeout: 8_000 });
              await sleep(300, 600);
              await page.locator('[data-testid="retweetConfirm"]').first().evaluate(el => el.click());
              await sleep(800, 1400);
              await account.bump('repost').catch(swallow('bump:repost', 'warn'));
              await log(account._id, 'engage', 'retweet', 'success', { tweetId });
              r = { success: true };
              break;
            }

            case 'bookmark': {
              // Scroll to trigger full render
              await page.mouse.wheel(0, 150);
              await sleep(400, 700);
              await page.mouse.wheel(0, -150);
              await page.waitForSelector('[data-testid="bookmark"],[data-testid="removeBookmark"]', { timeout: 20_000 });
              const already = await page.locator('[data-testid="removeBookmark"]').count().catch(() => 0);
              if (already) { r = { alreadyBookmarked: true }; break; }
              await page.locator('[data-testid="bookmark"]').first().evaluate(el => el.click());
              await sleep(500, 900);
              await log(account._id, 'engage', 'bookmark', 'success', { tweetId });
              r = { success: true };
              break;
            }

            case 'reply': {
              if (!replyText) { r = { skipped: true, reason: 'no reply text' }; break; }
              const replyBox = page.locator('[data-testid="reply"]').first();
              await replyBox.waitFor({ timeout: 15_000 });
              await replyBox.evaluate(el => el.click());
              await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10_000 });
              await sleep(400, 700);
              await page.locator('[data-testid="tweetTextarea_0"]').first().click();
              await this._humanType(page, replyText.slice(0, 280));
              await sleep(600, 1000);
              await page.locator('[data-testid="tweetButtonInline"]').first().evaluate(el => el.click());
              await sleep(1200, 2000);
              await account.bump('reply').catch(swallow('bump:reply', 'warn'));
              await log(account._id, 'engage', 'reply', 'success', { tweetId });
              r = { success: true };
              break;
            }

            case 'quote_tweet': {
              if (!quoteText) { r = { skipped: true, reason: 'no quote text' }; break; }

              // نظّف الـ URL من tracking params (s=, t=, ref_src=...)
              // ونبني URL نظيف من الـ tweetId مباشرة — أكثر ثباتاً
              const cleanTweetUrl = `https://x.com/i/status/${tweetId}`;
              const composeUrl    = `https://x.com/compose/post?url=${encodeURIComponent(cleanTweetUrl)}`;

              const ctx         = page.context();
              const composePage = await ctx.newPage();
              try {
                // فتح صفحة الكتابة مع الـ URL مباشرة — أكثر ثباتاً من النقر على dropdown
                await composePage.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
                // أغلق أي popup يظهر فور تحميل الصفحة
                await this._dismissPopups(composePage);
                await sleep(500, 800);

                // انتظر textarea الكتابة
                await composePage.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 20_000 });
                await sleep(800, 1200);

                // أغلق أي popup قبل الكتابة
                await this._dismissPopups(composePage);

                // انتظر textarea — جرب selectors متعددة
                const textareaVisible = await composePage.waitForSelector(
                  '[data-testid="tweetTextarea_0"], [data-testid="tweetTextarea_0root"], div[role="textbox"][data-block="true"]',
                  { timeout: 20_000 }
                ).then(() => true).catch(async () => {
                  // screenshot للتشخيص
                  const fs = require('fs');
                  fs.mkdirSync('./data/debug', { recursive: true });
                  await composePage.screenshot({ path: `./data/debug/quote-fail-${Date.now()}.png`, fullPage: true }).catch(() => {});
                  logger.warn(`[EngageTweet] @${account.username} — compose page URL: ${composePage.url()}`);
                  // جرب dismiss popup ثاني
                  await this._dismissPopups(composePage);
                  await sleep(1500, 2000);
                  // محاولة أخيرة
                  return composePage.waitForSelector(
                    '[data-testid="tweetTextarea_0"], div[contenteditable="true"][role="textbox"]',
                    { timeout: 10_000 }
                  ).then(() => true).catch(() => false);
                });

                if (!textareaVisible) {
                  throw new Error(`compose textarea not found — URL: ${composePage.url()}`);
                }

                // انتظر ظهور بطاقة الاقتباس — يؤكد إن X حمّل الـ attachment
                const cardAppeared = await composePage.waitForSelector(
                  '[data-testid="card.wrapper"], [data-testid="attachments"], [data-testid="quoteTweet"]',
                  { timeout: 10_000 }
                ).then(() => true).catch(() => false);

                if (!cardAppeared) {
                  logger.warn(`[EngageTweet] @${account.username} — quote card not loaded, retrying with scroll`);
                  await composePage.mouse.wheel(0, 200);
                  await sleep(1000, 1500);
                }

                // اكتب النص
                await composePage.locator('[data-testid="tweetTextarea_0"]').first().click();
                await sleep(400, 700);
                await this._humanType(composePage, quoteText.slice(0, 280));
                await sleep(700, 1200);

                // تحقق إن زر النشر enabled
                const postBtn = composePage.locator('[data-testid="tweetButtonInline"]').first();
                await postBtn.waitFor({ state: 'visible', timeout: 10_000 });
                await sleep(300, 500);
                await postBtn.evaluate(el => el.click());

                // انتظر إغلاق الـ composer — يعني النشر تم
                await composePage.waitForSelector('[data-testid="tweetTextarea_0"]', { state: 'detached', timeout: 10_000 }).catch(() => {});
                await sleep(1500, 2500);

                await account.bump('post').catch(swallow('bump:post', 'warn'));
                await log(account._id, 'engage', 'quote_tweet', 'success', { tweetId, tweetUrl });
                r = { success: true };
              } catch (qErr) {
                logger.warn(`[EngageTweet] @${account.username} — quote_tweet failed: ${qErr.message}`);
                r = { skipped: true, reason: qErr.message };
              } finally {
                await composePage.close().catch(() => {});
              }

              // ارجع للتغريدة الأصلية لو في actions بعدها
              await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
              await page.waitForSelector('[data-testid="like"],[data-testid="unlike"]', { timeout: 15_000 }).catch(() => {});
              await sleep(600, 1000);
              break;
            }

            case 'tweet_dwell': {
              // Already on the tweet — just scroll and wait
              const steps = Math.floor((dwellSeconds * 1000) / 1800);
              for (let i = 0; i < steps; i++) {
                await page.mouse.wheel(0, randInt(80, 180));
                await sleep(1000, 2000);
              }
              await page.mouse.wheel(0, -randInt(200, 350));
              await log(account._id, 'engage', 'tweet_dwell', 'success', { tweetId });
              r = { success: true };
              break;
            }

            case 'profile_visit': {
              if (!authorHandle) { r = { skipped: true, reason: 'no authorHandle' }; break; }
              const handle = authorHandle.replace('@', '');
              await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
              await page.waitForSelector('[data-testid="UserName"]', { timeout: 15_000 }).catch(() => {});
              const steps = Math.floor(((dwellSeconds || 8) * 1000) / 1500);
              for (let i = 0; i < steps; i++) {
                await page.mouse.wheel(0, randInt(100, 250));
                await sleep(800, 1600);
              }
              // Go back to tweet for remaining actions
              await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
              await sleep(600, 1000);
              await log(account._id, 'engage', 'profile_visit', 'success', { authorHandle: handle });
              r = { success: true };
              break;
            }

            case 'follow_author': {
              if (!authorHandle) { r = { skipped: true, reason: 'no authorHandle' }; break; }
              const handle = authorHandle.replace('@', '');
              // Navigate to profile
              await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
              await page.waitForSelector('[data-testid="placementTracking"]', { timeout: 15_000 }).catch(() => {});
              await sleep(600, 1000);
              const followBtn = page.locator('[data-testid="placementTracking"] [data-testid$="-follow"]').first();
              const count = await followBtn.count().catch(() => 0);
              if (!count) { r = { skipped: true, reason: 'already following or not found' }; break; }
              await followBtn.evaluate(el => el.click());
              await sleep(800, 1400);
              // Back to tweet
              await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
              await sleep(600, 1000);
              await account.bump('follow').catch(swallow('bump:follow', 'warn'));
              await log(account._id, 'engage', 'follow_author', 'success', { authorHandle: handle });
              r = { success: true };
              break;
            }

            case 'share': {
              const shareBtn = await page.waitForSelector(
                '[aria-haspopup="menu"][aria-label="Share post"], [aria-haspopup="menu"][aria-label="Share"]',
                { timeout: 15_000 }
              );
              await shareBtn.evaluate(el => el.click());
              await page.waitForSelector('[data-testid="Dropdown"]', { timeout: 8_000 });
              await sleep(400, 700);
              await page.locator('[data-testid="Dropdown"] [role="menuitem"]').first().evaluate(el => el.click());
              await sleep(500, 900);
              await page.keyboard.press('Escape').catch(() => {});
              await log(account._id, 'engage', 'share', 'success', { tweetId });
              r = { success: true };
              break;
            }

            default:
              r = { skipped: true, reason: `unknown action: ${act}` };
          }

          const res = r || { success: true };
          results.push({ action: act, ...res });
          if (res.success || res.alreadyLiked || res.alreadyRetweeted || res.alreadyBookmarked) {
            logger.info(`[EngageTweet] @${account.username} — ${act} ✓`);
          } else if (res.skipped) {
            logger.warn(`[EngageTweet] @${account.username} — ${act} skipped: ${res.reason}`);
          }

        } catch(e) {
          logger.warn(`[EngageTweet] @${account.username} — ${act} failed: ${e.message}`);
          results.push({ action: act, success: false, error: e.message });
          // Try to reload tweet page for next action
          if (!['profile_visit','follow_author','quote_tweet'].includes(act)) {
            await page.goto(`https://x.com/i/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
            await sleep(800, 1200);
          }
        }

        // Human-like delay between actions
        await sleep(1200, 2800);
      }

      return { success: true, results };

    } finally {
      await page.close().catch(() => {});
    }
  },

  async _humanType(page, text) {
    for (const ch of String(text)) {
      await page.keyboard.type(ch, { delay: randInt(30, 70) });
    }
  },
};

module.exports = ActionSvc;
