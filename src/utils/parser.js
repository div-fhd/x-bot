'use strict';
function parseLine(line) {
  const raw = (line || '').trim();
  if (!raw || raw.startsWith('#')) return null;

  // استخرج البروكسي إذا موجود في النهاية
  let rest = raw, proxy_url = null;
  const m = raw.match(/(socks5:\/\/|https?:\/\/).+$/);
  if (m) { proxy_url = m[0]; rest = raw.slice(0, raw.length - proxy_url.length - 1); }

  const parts = rest.split(':');

  // ── الفورمات المدعومة ──────────────────────────────────────
  // 1. login:password
  // 2. login:password:email
  // 3. login:password:email:session_token:auth_token          (الفورمات القديم)
  // 4. login:password:email:mailpassword:auth_token:2fa       (الفورمات الجديد)
  // 5. login:password:email:session_token:auth_token:proxy    (مع بروكسي)
  // ──────────────────────────────────────────────────────────

  let username, password, email, mail_password, session_token, auth_token, totp_secret;

  username = (parts[0] || '').replace('@', '').trim();
  password = (parts[1] || '').trim();
  email    = (parts[2] || '').trim() || null;

  if (parts.length >= 6) {
    // الفورمات الجديد: login:password:email:mailpassword:authtoken:2fa
    mail_password = (parts[3] || '').trim() || null;
    auth_token    = (parts[4] || '').trim() || null;
    totp_secret   = (parts[5] || '').trim() || null;
    session_token = null;
  } else if (parts.length === 5) {
    // login:password:email:session_token:auth_token
    session_token = (parts[3] || '').trim() || null;
    auth_token    = (parts[4] || '').trim() || null;
    mail_password = null;
    totp_secret   = null;
  } else if (parts.length === 4) {
    // login:password:email:session_token
    session_token = (parts[3] || '').trim() || null;
    mail_password = null;
    auth_token    = null;
    totp_secret   = null;
  } else {
    session_token = null;
    auth_token    = null;
    mail_password = null;
    totp_secret   = null;
  }

  const errors = [];
  if (!username) errors.push('username required');
  if (!password || password.length < 4) errors.push('password too short');

  return {
    valid: errors.length === 0, errors,
    username,
    password,
    email,
    mail_password,
    session_token,
    auth_token,
    totp_secret,
    proxy_url,
  };
}

function parseBulkText(text) {
  const lines  = (text || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  const parsed = lines.map(parseLine).filter(Boolean);
  return {
    parsed,
    valid:   parsed.filter(p => p.valid),
    invalid: parsed.filter(p => !p.valid),
    total:   parsed.length,
  };
}

module.exports = { parseLine, parseBulkText };