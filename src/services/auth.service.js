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

    const state = await this._classify(account, ctx);
    if (state === 'active') return ctx;

    logger.info(`[Auth] @${account.username} — state: ${state}, login required`);

    if (!creds.password) {
      // حدّث حالة الحساب في قاعدة البيانات
      const statusMap = { expired: 'يحتاج_مصادقة', checkpoint: 'نقطة_تحقق', suspended: 'موقوف', unknown: 'غير_نشط' };
      account.status        = statusMap[state] || 'يحتاج_مصادقة';
      account.lastCheckedAt = new Date();
      await account.save().catch(() => {});
      logger.warn(`[Auth] @${account.username} — status updated: ${account.status}`);
      throw new Error(`@${account.username}: no password and session is invalid (state: ${state})`);
    }

    logger.info(`[Auth] @${account.username} — waiting for login slot...`);
    await acquireLoginLock();
    logger.info(`[Auth] @${account.username} — login slot acquired`);
    try {
      await this._login(account, ctx, creds);
    } finally {
      releaseLoginLock();
      logger.info(`[Auth] @${account.username} — login slot released`);
    }

    const state2 = await this._classify(account, ctx);
    await log(account._id, 'auth', 'login_attempt', state2 === 'active' ? 'success' : 'failure', { state: state2 });

    if (state2 !== 'active') {
      await Browser.closeContext(account._id.toString());
      throw new Error(`Login failed: @${account.username} (state: ${state2})`);
    }

    await Browser.persistSession(account);

    // Close and reopen context so the new cookies are loaded from saved session
    // This ensures any subsequent getPage() calls get fresh authenticated cookies
    const id = account._id.toString();
    await Browser.closeContext(id);
    const freshCtx = await Browser.getContext(account);
    logger.info(`[Auth] @${account.username} — session saved, context refreshed ✓`);
    return freshCtx;
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
      return { state, status: account.status };
    } catch (e) {
      account.status     = 'غير_نشط';
      account.statusNote = e.message;
      await account.save().catch(() => {});
      logger.warn(`[Auth] Health check failed @${account.username}: ${e.message}`);
      return { state: 'error', error: e.message };
    }
  },

  // ── Classify current session ──────────────────────────────────
  async _classify(account, ctx) {
    const page = await ctx.newPage();
    try {
      await page.goto(X_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(2000, 3000);

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

      // انتظر أي علامة على إن الصفحة حملت
      const ready = await Promise.race([
        page.locator('[data-testid="primaryColumn"]').waitFor({ timeout: 15_000 }).then(() => true),
        page.locator('[data-testid="SideNav_NewTweet_Button"]').waitFor({ timeout: 15_000 }).then(() => true),
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

      return 'expired';
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
    const shot = async (name) => page.screenshot({ path: `${DEBUG_DIR}/${name}.png`, fullPage: false }).catch(() => {});

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
        await shot('err_unusual_activity');
        throw new Error(`X flagged unusual activity for @${account.username} — manual verification required`);
      } else if (midState === 'password') {
        // Already at password — nothing to do
      }
      // 'unknown' — fall through and try to find password field anyway

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
        const url  = page.url();
        const body = await page.locator('body').textContent().catch(() => '').then(t => t.slice(0, 200));
        throw new Error(`Password field not found after 4 attempts — URL: ${url} | Page: ${body}`);
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
    // Small extra wait
    await sleep(500, 800);

    const url = page.url();

    // Password field visible right away — clean normal flow
    const hasPassword = await page.locator('input[type="password"]').count().catch(() => 0);
    if (hasPassword > 0) return 'password';

    // Verify email/phone input
    const hasVerify = await page.locator('input[data-testid="ocfEnterTextTextInput"]').count().catch(() => 0);
    if (hasVerify > 0) return 'email_phone';

    // Unusual activity / blocked
    if (url.includes('/account/access') || url.includes('/challenge')) return 'unusual_activity';

    const bodyText = await page.locator('body').textContent().catch(() => '');
    if (bodyText.toLowerCase().includes('unusual') || bodyText.toLowerCase().includes('verify your identity')) {
      return 'unusual_activity';
    }

    return 'unknown';
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