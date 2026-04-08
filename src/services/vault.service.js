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
      passwordEnc:    this.enc(raw.password),
      email:          raw.email         || null,
      sessionTokenEnc:raw.session_token ? this.enc(raw.session_token) : null,
      authTokenEnc:   raw.auth_token    ? this.enc(raw.auth_token)    : null,
      totpSecretEnc:  raw.totp_secret   ? this.enc(raw.totp_secret)   : null,
    };
  },

  decryptAccount(stored) {
    return {
      password:      this.dec(stored.passwordEnc),
      email:         stored.email          || null,
      session_token: stored.sessionTokenEnc ? this.dec(stored.sessionTokenEnc) : null,
      auth_token:    stored.authTokenEnc    ? this.dec(stored.authTokenEnc)    : null,
      totp_secret:   stored.totpSecretEnc   ? this.dec(stored.totpSecretEnc)   : null,
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

  buildStateFromTokens(creds) {
    if (!creds.auth_token) return null;
    const cookies = [
      { name:'auth_token', value:creds.auth_token, domain:'.x.com', path:'/', httpOnly:true, secure:true, sameSite:'None' },
    ];
    if (creds.session_token) {
      cookies.push({ name:'ct0', value:creds.session_token, domain:'.x.com', path:'/', httpOnly:false, secure:true, sameSite:'Lax' });
    }
    return { cookies, origins:[] };
  },

  fingerprint(state) {
    const str = JSON.stringify((state?.cookies || []).map(c => ({ n:c.name, v:c.value })));
    return crypto.createHash('sha256').update(str).digest('hex');
  },
};

module.exports = Vault;
