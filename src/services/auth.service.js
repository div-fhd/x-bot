'use strict';
/**
 * AuthService v4
 *
 * Key fixes:
 *  - Never open a new page inside classify() while login is in progress on the same context
 *  - After username entry: smart detection of what appeared (password / email challenge / unusual activity)
 *  - Longer waits between steps (X login is slow)
 *  - Better error messages referencing current URL
 *  - Screenshot on every failure for debugging
 */
const path    = require('path');
const fs      = require('fs');
const Browser = require('./browser.service');
const Vault   = require('./vault.service');
const { log } = require('../models/index');
const logger  = require('../utils/logger');
const { sleep, randInt } = require('../utils/delay');

const X_LOGIN   = 'https://x.com/i/flow/login';
const X_HOME    = 'https://x.com/home';
const DEBUG_DIR = './data/debug';
fs.mkdirSync(DEBUG_DIR, { recursive: true });

// Global login serializer — only one login at a time across all accounts.
// Simultaneous logins from the same IP trigger X's bot detection.
let _loginLock    = false;
const _loginQueue = [];

async function acquireLoginLock() {
  return new Promise(resolve => {
    const tryAcquire = () => {
      if (!_loginLock) {
        _loginLock = true;
        resolve();
      } else {
        _loginQueue.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}

function releaseLoginLock() {
  _loginLock = false;
  if (_loginQueue.length > 0) {
    const next = _loginQueue.shift();
    next();
  }
}

const AuthSvc = {

  // ── ensureSession: called before every browser action ────────
  async ensureSession(account) {
    const creds = Vault.decryptAccount(account.credentials);
    const ctx   = await Browser.getContext(account);

    // الخطوة 1: تجاوز API verify — غير موثوق على السيرفر

    let state = await this._classify(account, ctx);

    // unknown = خطأ مؤقت (بطء شبكة، timeout) — نعيد المحاولة مرة واحدة
    if (state === 'unknown') {
      logger.info(`[Auth] @${account.username} — unknown state، إعادة المحاولة...`);
      await sleep(3000, 5000);
      state = await this._classify(account, ctx);
    }

    if (state === 'active') return ctx;

    // حالة محددة — لا تحاول login أثناء العمليات، تخطَّ فوراً
    // unknown بعد الـ retry = مشكلة مؤقتة، لا نغير حالة الحساب في DB
    const statusMap = { expired: 'يحتاج_مصادقة', checkpoint: 'نقطة_تحقق', suspended: 'موقوف' };
    if (statusMap[state]) {
      account.status        = statusMap[state];
      account.lastCheckedAt = new Date();
      await account.save().catch(() => {});
    }
    await Browser.closeContext(account._id.toString()).catch(() => {});
    logger.warn(`[Auth] @${account.username} — تخطي: ${state}`);
    throw new Error(`SKIP:@${account.username} — ${state}`);
  },

  // ── Health check ─────────────────────────────────────────────
  async checkHealth(account) {
    // تأخير عشوائي لتفادي فتح متصفحات متعددة في نفس الوقت
    await sleep(randInt(0, 2000));
    try {
      const creds = Vault.decryptAccount(account.credentials);
      const statusMap = {
        active:     'نشط',
        expired:    'يحتاج_مصادقة',
        checkpoint: 'نقطة_تحقق',
        suspended:  'موقوف',
        unknown:    'غير_نشط',
      };

      // فحص عبر المتصفح فقط — الأكثر موثوقية على السيرفر

      // ثانياً — فحص عبر المتصفح مع timeout أطول
      const ctx   = await Browser.getContext(account);
      const state = await this._classify(account, ctx);
      account.status        = statusMap[state] || 'غير_نشط';
      account.lastCheckedAt = new Date();
      if (state === 'active') account.lastActiveAt = new Date();
      await account.save();
      await log(account._id, 'session', 'health_check', 'success', { state, method: 'browser' });
      logger.info(`[Auth] Health check @${account.username}: ${state} → ${account.status}`);
      // أغلق الـ context بعد الفحص فوراً لتحرير الذاكرة
      await Browser.closeContext(account._id.toString()).catch(() => {});
      return { state, status: account.status };
    } catch (e) {
      account.status     = 'غير_نشط';
      account.statusNote = e.message;
      await account.save().catch(() => {});
      await Browser.closeContext(account._id.toString()).catch(() => {});
      logger.warn(`[Auth] Health check failed @${account.username}: ${e.message}`);
      return { state: 'error', error: e.message };
    }
  },

  // ── Classify current session ──────────────────────────────────
  async _classify(account, ctx) {
    const page = await ctx.newPage();
    try {
      // تحقق من الـ cookies قبل التنقل — لو auth_token موجود في الـ context
      const cookies = await ctx.cookies('https://x.com').catch(() => []);
      const hasAuth = cookies.some(c => c.name === 'auth_token' && c.value?.length > 10);
      if (!hasAuth) {
        // حاول inject الـ cookies من الـ credentials
        const Vault   = require('./vault.service');
        const creds   = Vault.decryptAccount(account.credentials);
        const state   = Vault.buildStateFromTokens(creds);
        if (state?.cookies?.length) {
          await ctx.addCookies(state.cookies);
          logger.info(`[Auth] @${account.username} — injected ${state.cookies.length} cookies manually`);
        }
      }

      await sleep(500, 1000);
      await page.goto(X_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(async (e) => {
        // لو timeout — تحقق من الـ URL الحالي قبل ما نرمي خطأ
        const url = page.url();
        if (url && url !== 'about:blank' && !url.includes('x.com/home')) throw e;
        // الصفحة بدأت تحمل — تابع
      });
      await sleep(3000, 5000);  // X.com SPA تحتاج وقت أطول بعد domcontentloaded
      // عرض حالة البروكسي فقط بدون فتح صفحة
      const hasProxy = !!account.network?.proxyUrl;
      logger.info(`[IP] @${account.username} — proxy: ${hasProxy ? '✅ ' + (account.network.proxyUrl.split('@')[1]||'') : '❌ بدون بروكسي'}`);

      // أغلق cookie popup إذا ظهر
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
          .find(b => ['Aceitar','Accept','Recusar','Decline'].some(t => b.textContent.trim().startsWith(t)));
        if (btn) btn.click();
      }).catch(() => {});

      const url = page.url();
      if (url.includes('/login') || url.includes('/i/flow/login')) return 'expired';
      if (url.includes('/account/access') || url.includes('/challenge')) return 'checkpoint';
      if (url.includes('/suspended')) return 'suspended';

      // كشف صفحة خطأ X "Something went wrong" — اضغط Try again
      const xError = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        return body.includes('Something went wrong') || body.includes('Try again');
      }).catch(() => false);

      if (xError) {
        logger.info(`[Auth] @${account.username} — X error page, pressing Try again...`);
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('button')]
            .find(b => b.textContent.trim().toLowerCase().includes('try again') || b.textContent.trim().includes('حاول'));
          if (btn) btn.click();
        }).catch(() => {});
        await sleep(4000, 6000);
        // تحقق من الـ URL بعد المحاولة
        const urlAfter = page.url();
        if (urlAfter.includes('/login')) return 'expired';
        // اعطِ X وقتاً إضافياً
        await sleep(3000, 4000);
      }

      // انتظر أي علامة على إن الصفحة حملت
      const ready = await Promise.race([
        page.locator('[data-testid="primaryColumn"]').waitFor({ timeout: 10_000 }).then(() => true),
        page.locator('[data-testid="SideNav_NewTweet_Button"]').waitFor({ timeout: 10_000 }).then(() => true),
        page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').waitFor({ timeout: 10_000 }).then(() => true),
        page.locator('[aria-label="Home timeline"]').waitFor({ timeout: 10_000 }).then(() => true),
      ]).catch(() => false);

      if (ready) {
        account.status        = 'نشط';
        account.lastActiveAt  = new Date();
        account.lastCheckedAt = new Date();
        await account.save().catch(() => {});
        return 'active';
      }

      // تحقق مرة ثانية من الـ URL بعد التحميل
      const url2 = page.url();
      if (url2.includes('/login') || url2.includes('/i/flow')) return 'expired';

      // لم تحمل الصفحة في الوقت المحدد — قد يكون بطء شبكة مؤقت، ليس بالضرورة expired
      return 'unknown';
    } catch (e) {
      logger.warn(`[Auth] classify error @${account.username}: ${e.message}`);
      return 'unknown';
    } finally {
      await page.close().catch(() => {});
    }
  },

  // ── Full login flow ───────────────────────────────────────────
  async _login(account, ctx, creds) {
    const page = await ctx.newPage();
    const shot = async (name) => process.env.DEBUG_SCREENSHOTS === 'true' ? page.screenshot({ path: `${DEBUG_DIR}/${name}.png`, fullPage: false }).catch(() => {}) : Promise.resolve();

    try {
      logger.info(`[Auth] Starting login: @${account.username}`);

      await page.goto(X_LOGIN, { waitUntil: 'load', timeout: 35_000 });
      // Wait for JS to hydrate — X login is SPA, DOM loads fast but inputs render later
      await sleep(4000, 6000);
      await shot('01_login_page');

      // ── Step 1: Username ──────────────────────────────────────
      const userSel = [
        'input[autocomplete="username"]',
        'input[name="text"]',
        'input[data-testid="ocfEnterTextTextInput"]',
      ].join(', ');

      const userInput = await page.waitForSelector(userSel, { state: 'visible', timeout: 30_000 })
        .catch(() => null);

      if (!userInput) {
        await shot('err_no_username_field');
        const url      = page.url();
        const title    = await page.title().catch(() => '');
        const bodyText = await page.locator('body').textContent().catch(() => '').then(t => t.slice(0, 500));
        // Dump full HTML for inspection
        const html = await page.content().catch(() => '');
        require('fs').writeFileSync('./data/debug/err_login_page.html', html, 'utf8');
        throw new Error(`Username field not found — URL: ${url} | Title: ${title} | Body: ${bodyText.replace(/\s+/g,' ').trim()}`);
      }

      await userInput.click();
      await sleep(500, 900);
      await this._humanType(page, account.username);
      await sleep(1000, 1600);
      logger.info(`[Auth] @${account.username} — username entered`);

      // Click Next button (more reliable than pressing Enter)
      const nextBtn = await page.$('div[data-testid="LoginForm_Login_Button"], button:has-text("Next"), [role="button"]:has-text("Next")')
        .catch(() => null);
      if (nextBtn && await nextBtn.isVisible().catch(()=>false)) {
        await nextBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      await sleep(3000, 4500);
      await shot('02_after_username');

      // ── Step 2: Detect what X showed ─────────────────────────
      const midState = await this._detectMidScreen(page);
      logger.info(`[Auth] @${account.username} — mid-screen state: ${midState}`);

      if (midState === 'email_phone') {
        // X wants email or phone number to verify identity
        const verifyInput = await page.$('input[data-testid="ocfEnterTextTextInput"]').catch(()=>null);
        if (verifyInput) {
          const verifyValue = creds.email || account.username;
          logger.info(`[Auth] @${account.username} — email/phone challenge, entering: ${verifyValue}`);
          await verifyInput.fill(verifyValue);
          await sleep(700, 1200);
          await page.keyboard.press('Enter');
          await sleep(3000, 4000);
          await shot('03_after_email_verify');
        }
      } else if (midState === 'unusual_activity') {
        account.status = 'نقطة_تحقق';
        account.lastCheckedAt = new Date();
        await account.save().catch(() => {});
        throw new Error(`SKIP:@${account.username} — نقطة_تحقق`);
      } else if (midState === 'suspended') {
        account.status = 'موقوف';
        account.lastCheckedAt = new Date();
        await account.save().catch(() => {});
        throw new Error(`SKIP:@${account.username} — موقوف`);
      } else if (midState === 'password') {
        // Already at password — nothing to do
      }
      // unknown — fall through

      // ── Step 3: Password ──────────────────────────────────────
      const passSel = 'input[type="password"], input[name="password"]';
      let passInput = null;

      // Try multiple times — X sometimes takes a moment
      for (let attempt = 0; attempt < 4; attempt++) {
        passInput = await page.waitForSelector(passSel, { state: 'visible', timeout: 8_000 })
          .catch(() => null);
        if (passInput) break;
        logger.warn(`[Auth] @${account.username} — password field not found (attempt ${attempt+1})`);
        await sleep(2000, 3000);
        await shot(`03_password_wait_${attempt}`);
      }

      if (!passInput) {
        await shot('err_no_password_field');
        account.status = 'يحتاج_مصادقة';
        account.lastCheckedAt = new Date();
        await account.save().catch(() => {});
        throw new Error(`SKIP:@${account.username} — يحتاج_مصادقة`);
      }

      await passInput.click();
      await sleep(500, 900);
      await this._humanType(page, creds.password);
      await sleep(1000, 1600);
      logger.info(`[Auth] @${account.username} — password entered`);

      // Click Log in button
      const loginBtn = await page.$('[data-testid="LoginForm_Login_Button"], div[role="button"]:has-text("Log in")')
        .catch(()=>null);
      if (loginBtn && await loginBtn.isEnabled().catch(()=>false)) {
        await loginBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }

      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
      await sleep(3000, 5000);
      await shot('04_after_login');

      // ── Step 4: 2FA (optional) ────────────────────────────────
      const codeInput = await page.$('input[data-testid="LoginForm_authenticator_input"], input[name="text"]')
        .catch(()=>null);
      if (codeInput && await codeInput.isVisible().catch(()=>false)) {
        if (creds.totp_secret) {
          const code = this._generateTOTP(creds.totp_secret);
          logger.info(`[Auth] @${account.username} — entering 2FA code`);
          await codeInput.fill(code);
          await sleep(500, 900);
          await page.keyboard.press('Enter');
          await page.waitForNavigation({ waitUntil:'domcontentloaded', timeout:20_000 }).catch(()=>{});
          await sleep(2500, 4000);
        } else {
          throw new Error(`2FA required for @${account.username} — add totp_secret to the account`);
        }
      }

      logger.info(`[Auth] @${account.username} — login flow complete`);

    } catch (e) {
      logger.error(`[Auth] Login error @${account.username}: ${e.message}`);
      await shot('err_login_failed').catch(()=>{});
      throw e;
    } finally {
      await page.close().catch(() => {});
    }
  },

  // ── Detect what appeared after entering username ──────────────
  async _detectMidScreen(page) {
    await sleep(1500, 2500);

    const url = page.url();

    // Cloudflare / account access
    if (url.includes('/account/access') || url.includes('challenge')) return 'unusual_activity';

    // انتظر أي input يظهر
    await page.waitForSelector('input', { timeout: 8000 }).catch(() => {});

    const state = await page.evaluate(() => {
      // password field
      if (document.querySelector('input[type="password"], input[name="password"]'))
        return 'password';

      // email/phone challenge
      const ocf = document.querySelector('input[data-testid="ocfEnterTextTextInput"]');
      if (ocf) return 'email_phone';

      // any text input visible
      const inputs = [...document.querySelectorAll('input[type="text"], input:not([type])')];
      const vis = inputs.find(i => i.offsetParent !== null);
      if (vis) {
        const ph = (vis.placeholder || '').toLowerCase();
        if (ph.includes('phone') || ph.includes('email') || ph.includes('username'))
          return 'email_phone';
        return 'unknown_input';
      }

      const txt = document.body.innerText.toLowerCase();
      if (txt.includes('unusual') || txt.includes('verify your identity') || txt.includes('confirm your identity'))
        return 'unusual_activity';
      if (txt.includes('suspended') || txt.includes('locked'))
        return 'suspended';

      return 'unknown';
    }).catch(() => 'unknown');

    return state;
  },

  // ── التحقق من صلاحية auth_token عبر API ─────────────────────
  async _verifyViaAPI(creds) {
    try {
      const https  = require('https');
      const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

      // بناء الـ cookies
      let cookie = `auth_token=${creds.auth_token}`;
      if (creds.session_token) cookie += `; ct0=${creds.session_token}`;

      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.twitter.com',
          path: '/1.1/account/verify_credentials.json?skip_status=true&include_entities=false',
          method: 'GET',
          headers: {
            'Authorization':  `Bearer ${BEARER}`,
            'Cookie':         cookie,
            'x-csrf-token':   creds.session_token || creds.auth_token.slice(0, 32),
            'User-Agent':     'TwitterAndroid/10.21.0-release.0 (310210000-r-0) ONEPLUS+A3010/9 (OnePlus;ONEPLUS+A3010;OnePlus;OnePlus3;0;;1;2016)',
            'x-twitter-client-language': 'en',
          },
        }, (res) => {
          let raw = '';
          res.on('data', c => raw += c);
          res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });

      logger.info(`[Auth] _verifyViaAPI @${creds.auth_token?.slice(0,8)}… → ${result.status} | ${result.body?.slice(0,80)}`);
      return result.status === 200;
    } catch (e) {
      logger.warn(`[Auth] _verifyViaAPI error: ${e.message}`);
      return false;
    }
  },

  // ── Human-like typing ─────────────────────────────────────────
  async _humanType(page, text) {
    for (const ch of String(text)) {
      await page.keyboard.type(ch, { delay: randInt(65, 145) });
    }
  },

  // ── TOTP ──────────────────────────────────────────────────────
  _generateTOTP(secret) {
    try {
      return require('speakeasy').totp({ secret, encoding: 'base32' });
    } catch {
      logger.warn('[Auth] speakeasy not installed — 2FA step will fail');
      return '';
    }
  },
};

module.exports = AuthSvc;