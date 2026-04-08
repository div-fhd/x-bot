'use strict';
function parseLine(line) {
  const raw = (line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  let rest = raw, proxy_url = null;
  const m = raw.match(/(socks5:\/\/|https?:\/\/).+$/);
  if (m) { proxy_url = m[0]; rest = raw.slice(0, raw.length - proxy_url.length - 1); }
  const [username, password, email, session_token, auth_token] = rest.split(':');
  const errors = [];
  if (!username?.trim()) errors.push('username required');
  if (!password || password.trim().length < 4) errors.push('password too short');
  return {
    valid: errors.length === 0, errors,
    username:      (username || '').replace('@', '').trim(),
    password:      (password || '').trim(),
    email:         (email || '').trim()         || null,
    session_token: (session_token || '').trim() || null,
    auth_token:    (auth_token || '').trim()    || null,
    proxy_url,
  };
}
function parseBulkText(text) {
  const lines   = (text || '').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  const parsed  = lines.map(parseLine).filter(Boolean);
  return { parsed, valid: parsed.filter(p => p.valid), invalid: parsed.filter(p => !p.valid), total: parsed.length };
}
module.exports = { parseLine, parseBulkText };
