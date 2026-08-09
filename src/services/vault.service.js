'use strict';
const CryptoJS = require('crypto-js');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const cfg      = require('../config');

const KEY = cfg.vaultKey.slice(0, 32);

const Vault = {
  enc(plain) {
    if (!plain) return null;
    const iv  = CryptoJS.lib.WordArray.random(16);
    const key = CryptoJS.enc.Utf8.parse(KEY);
    const ct  = CryptoJS.AES.encrypt(plain, key, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
    return `${iv.toString(CryptoJS.enc.Hex)}:${ct.ciphertext.toString(CryptoJS.enc.Hex)}`;
  },

  dec(str) {
    if (!str) return null;
    const [ivHex, cHex] = str.split(':');
    if (!ivHex || !cHex) return null;
    try {
      const key = CryptoJS.enc.Utf8.parse(KEY);
      const cip = CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Hex.parse(cHex) });
      return CryptoJS.AES.decrypt(cip, key, { iv: CryptoJS.enc.Hex.parse(ivHex), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString(CryptoJS.enc.Utf8);
    } catch { return null; }
  },

  encryptAccount(raw) {
    return {
      passwordEnc:     this.enc(raw.password),
      email:           raw.email          || null,
      sessionTokenEnc: raw.session_token  ? this.enc(raw.session_token)  : null,
      authTokenEnc:    raw.auth_token     ? this.enc(raw.auth_token)     : null,
      totpSecretEnc:   raw.totp_secret    ? this.enc(raw.totp_secret)    : null,
      mailPasswordEnc: raw.mail_password  ? this.enc(raw.mail_password)  : null,
    };
  },

  decryptAccount(stored) {
    return {
      password:      this.dec(stored.passwordEnc),
      email:         stored.email              || null,
      session_token: stored.sessionTokenEnc    ? this.dec(stored.sessionTokenEnc)    : null,
      auth_token:    stored.authTokenEnc       ? this.dec(stored.authTokenEnc)       : null,
      totp_secret:   stored.totpSecretEnc      ? this.dec(stored.totpSecretEnc)      : null,
      mail_password: stored.mailPasswordEnc    ? this.dec(stored.mailPasswordEnc)    : null,
    };
  },

  sessionPath: (id) => path.join(cfg.browser.sessionDir, `${id}.json`),

  async saveSession(accountId, state) {
    fs.mkdirSync(cfg.browser.sessionDir, { recursive: true });
    await fs.promises.writeFile(this.sessionPath(accountId), this.enc(JSON.stringify(state)), 'utf8');
  },

  async loadSession(accountId) {
    try {
      const raw = await fs.promises.readFile(this.sessionPath(accountId), 'utf8');
      const dec = this.dec(raw);
      return dec ? JSON.parse(dec) : null;
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[Vault] loadSession failed:', e.message);
      return null;
    }
  },

  async deleteSession(accountId) {
    try { await fs.promises.unlink(this.sessionPath(accountId)); } catch {}
  },

  normalizeSessionState(state, creds = {}) {
    if (!state) return null;

    const original = Array.isArray(state.cookies) ? state.cookies : [];
    const isSessionCookie = cookie =>
      ['auth_token', 'ct0'].includes(cookie.name) &&
      /^(?:\.?x\.com|\.?twitter\.com)$/i.test(cookie.domain || '');
    const findValue = name => {
      const matches = original.filter(cookie => cookie.name === name && isSessionCookie(cookie));
      return matches.find(cookie => cookie.domain === '.x.com')?.value
        || matches.find(cookie => cookie.domain === 'x.com')?.value
        || matches[0]?.value
        || null;
    };

    const authToken = creds.auth_token || findValue('auth_token');
    // Prefer the ct0 saved by the live browser because X may rotate it.
    const csrfToken = findValue('ct0') || creds.session_token;
    const cookies = original.filter(cookie => !isSessionCookie(cookie));

    if (authToken) cookies.push({
      name: 'auth_token', value: authToken,
      domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None',
    });
    if (csrfToken) cookies.push({
      name: 'ct0', value: csrfToken,
      domain: '.x.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax',
    });

    return { ...state, cookies };
  },

  buildStateFromTokens(creds) {
    if (!creds.auth_token) return null;

    // نضع cookies على كل الدومينات التي X يستخدمها
    // A single domain cookie covers x.com and all its subdomains. Exact-domain
    // duplicates can send different ct0 values and trigger X API error 353.
    const cookies = [{
      name: 'auth_token', value: creds.auth_token,
      domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None',
    }];
    if (creds.session_token) cookies.push({
      name: 'ct0', value: creds.session_token,
      domain: '.x.com', path: '/', httpOnly: false, secure: true, sameSite: 'Lax',
    });

    // guest_id عشوائي — X يتوقعه موجوداً
    const guestId = 'v1%3A' + Date.now() + Math.floor(Math.random() * 1e9);
    cookies.push({ name: 'guest_id', value: guestId, domain: '.x.com', path: '/', secure: true, sameSite: 'None' });

    return { cookies, origins: [] };
  },

  fingerprint(state) {
    const str = JSON.stringify((state?.cookies || []).map(c => ({ n:c.name, v:c.value })));
    return crypto.createHash('sha256').update(str).digest('hex');
  },
};

module.exports = Vault;
