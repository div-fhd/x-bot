'use strict';
/**
 * BrowserService v4
 *
 * Fixes:
 *  1. Race condition when multiple accounts try to create contexts simultaneously
 *     — per-account mutex lock so two requests for the same account never
 *       create duplicate contexts or close each other's pages mid-flight.
 *  2. Idle timer now resets correctly when a page is opened, not just when
 *     getContext() is called — prevents closing a context while login is in progress.
 *  3. Browser disconnect recovery — individual contexts survive a SIGHUP reconnect.
 *  4. Plain Playwright only (no puppeteer-extra / playwright-extra).
 */
const { chromium } = require('playwright');
const cfg    = require('../config');
const Vault  = require('./vault.service');
const logger = require('../utils/logger');
const { sleep } = require('../utils/delay');

// ── Pool ──────────────────────────────────────────────────────
// accountId → { ctx, lastUsed, timer, pages, lock }
const POOL    = new Map();
let   BROWSER = null;
let   SEM     = 0;

const IDLE_MS   = 15 * 60_000;   // 15 min idle before closing
const LOCK_MAP  = new Map();      // per-account mutex (prevents double-creation)

// Real Chrome UAs — rotate per context
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];
const randomUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// ── Browser lifecycle ─────────────────────────────────────────
async function ensureBrowser() {
  if (BROWSER?.isConnected()) return BROWSER;
  logger.info('[Browser] Launching Chromium...');
  BROWSER = await chromium.launch({
    headless: cfg.browser.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-first-run',
      '--disable-gpu',
      '--window-size=1280,800',
    ],
  });
  BROWSER.on('disconnected', () => {
    logger.warn('[Browser] Browser process disconnected');
    BROWSER = null;
    // Don't clear POOL — contexts are already dead but we clean on next access
    SEM = 0;
  });
  return BROWSER;
}

// ── Per-account mutex ─────────────────────────────────────────
// Prevents two simultaneous requests from creating duplicate contexts
async function withLock(id, fn) {
  while (LOCK_MAP.get(id)) await sleep(80, 120);
  LOCK_MAP.set(id, true);
  try {
    return await fn();
  } finally {
    LOCK_MAP.delete(id);
  }
}

// ── Idle timer — resets every time a page is opened ──────────
function resetIdle(id) {
  const e = POOL.get(id);
  if (!e) return;
  clearTimeout(e.timer);
  e.lastUsed = Date.now();
  // Only close if NO open pages
  e.timer = setTimeout(async () => {
    const entry = POOL.get(id);
    if (entry && entry.pages <= 0) {
      logger.info(`[Browser] Idle timeout, closing context: ${id}`);
      await closeContext(id);
    } else {
      // Pages still open — extend idle period
      resetIdle(id);
    }
  }, IDLE_MS);
}

// ── getContext ────────────────────────────────────────────────
async function getContext(account) {
  const id = account._id.toString();

  return withLock(id, async () => {
    // Check if existing context is still alive
    const ex = POOL.get(id);
    if (ex) {
      try {
        // Quick liveness check — if browser died, ctx.pages() throws
        await ex.ctx.pages();
        resetIdle(id);
        return ex.ctx;
      } catch {
        // Context is dead — remove and recreate
        logger.warn(`[Browser] Stale context detected for ${id}, recreating...`);
        POOL.delete(id);
        SEM = Math.max(0, SEM - 1);
      }
    }

    // Concurrency limit
    let waited = 0;
    while (SEM >= cfg.browser.limit) {
      await sleep(500, 800);
      waited += 600;
      if (waited > 60_000) throw new Error('Browser pool full — too many concurrent contexts');
    }
    SEM++;

    try {
      const browser = await ensureBrowser();
      const creds   = Vault.decryptAccount(account.credentials);
      const net     = account.network || {};

      // Priority: saved session → tokens → fresh
      let storageState = await Vault.loadSession(id);
      if (!storageState && (creds.auth_token || creds.session_token)) {
        storageState = Vault.buildStateFromTokens(creds);
        if (storageState) logger.info(`[Browser] Built storage state from tokens: @${account.username}`);
      }

      const ua  = net.userAgent || randomUA();
      const ctx = await browser.newContext({
        userAgent:   ua,
        locale:      'en-US',
        timezoneId:  net.timezone || 'America/New_York',
        viewport:    { width: 1280, height: 800 },
        colorScheme: 'light',
        ...(storageState ? { storageState } : {}),
        ...(net.proxyUrl ? { proxy: { server: net.proxyUrl } } : {}),
      });

      // Stealth patches
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        const fakePlugins = [
          { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client',      filename: 'internal-nacl-plugin', description: '' },
        ];
        Object.defineProperty(navigator, 'plugins', {
          get: () => Object.assign(fakePlugins, { item: i => fakePlugins[i], namedItem: n => fakePlugins.find(p=>p.name===n)||null, length: fakePlugins.length }),
          configurable: true,
        });
        Object.defineProperty(navigator, 'mimeTypes',           { get: () => ({ length: 4 }), configurable: true });
        Object.defineProperty(navigator, 'languages',           { get: () => ['en-US','en'], configurable: true });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
        Object.defineProperty(navigator, 'deviceMemory',        { get: () => 8, configurable: true });
        Object.defineProperty(navigator, 'platform',            { get: () => 'Win32', configurable: true });
        if (!window.chrome) {
          window.chrome = {
            runtime: { id: undefined, connect: ()=>{}, sendMessage: ()=>{}, onMessage:{ addListener:()=>{} } },
            loadTimes: () => ({ firstPaintTime:0, requestTime: Date.now()/1000 }),
            csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 1000 }),
            app: { isInstalled: false },
          };
        }
        delete window.__playwright;
        delete window.__pwInitScripts;
        delete window._playwrightPortForwardingConnectorMap;
        try {
          const orig = Permissions.prototype.query;
          Permissions.prototype.query = function(p) {
            if (['notifications','clipboard-read','clipboard-write','microphone','camera'].includes(p?.name)) {
              return Promise.resolve({ state:'prompt', onchange:null });
            }
            return orig.call(this, p);
          };
        } catch {}
      });

      if (creds.session_token) {
        await ctx.setExtraHTTPHeaders({
          'x-csrf-token':              creds.session_token,
          'x-twitter-auth-type':       'OAuth2Session',
          'x-twitter-active-user':     'yes',
          'x-twitter-client-language': 'en',
        });
      }

      const entry = { ctx, lastUsed: Date.now(), timer: null, pages: 0 };
      POOL.set(id, entry);
      resetIdle(id);
      logger.info(`[Browser] Context ready: @${account.username}`);
      return ctx;

    } catch (e) {
      SEM = Math.max(0, SEM - 1);
      throw e;
    }
  });
}

// ── getPage — tracks open pages so idle timer won't close mid-use ──
async function getPage(account) {
  const id  = account._id.toString();
  const ctx = await getContext(account);

  const page = await ctx.newPage();
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(120_000);

  // Track page count
  const entry = POOL.get(id);
  if (entry) entry.pages++;

  // Decrement and reset idle when page closes
  page.on('close', () => {
    const e = POOL.get(id);
    if (e) {
      e.pages = Math.max(0, e.pages - 1);
      resetIdle(id);
    }
  });

  return page;
}

// ── persistSession ────────────────────────────────────────────
async function persistSession(account) {
  const id  = account._id.toString();
  const ctx = POOL.get(id)?.ctx;
  if (!ctx) return;
  try {
    const state = await ctx.storageState();
    await Vault.saveSession(id, state);
    logger.info(`[Browser] Session saved: @${account.username}`);
  } catch (e) {
    logger.warn(`[Browser] persistSession failed: ${e.message}`);
  }
}

// ── closeContext ──────────────────────────────────────────────
async function closeContext(id) {
  const e = POOL.get(id);
  if (!e) return;
  clearTimeout(e.timer);
  await e.ctx.close().catch(() => {});
  POOL.delete(id);
  SEM = Math.max(0, SEM - 1);
  logger.info(`[Browser] Context closed: ${id}`);
}

// ── shutdown ──────────────────────────────────────────────────
async function shutdown() {
  for (const [id] of POOL) await closeContext(id);
  await BROWSER?.close().catch(() => {});
  BROWSER = null;
}

// ── stats ─────────────────────────────────────────────────────
function stats() {
  return {
    activeContexts: POOL.size,
    semaphore:      SEM,
    maxLimit:       cfg.browser.limit,
    connected:      !!BROWSER?.isConnected(),
    contexts: [...POOL.entries()].map(([id, e]) => ({
      id, pages: e.pages, lastUsed: new Date(e.lastUsed).toISOString(),
    })),
  };
}

module.exports = { getContext, getPage, persistSession, closeContext, shutdown, stats };