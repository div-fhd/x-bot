'use strict';
const https  = require('https');
const http   = require('http');
const logger = require('../utils/logger');

// حالة الترخيص المخزنة محلياً
let _license = {
  valid:       false,
  checked:     false,
  permissions: {},
  subscriber:  null,
  daysLeft:    null,
  endDate:     null,
  error:       null,
};

// ── التحقق من الترخيص ─────────────────────────────────────────
async function verifyLicense() {
  const key    = process.env.LICENSE_KEY;
  const server = process.env.ADMIN_SERVER;

  if (!key || !server) {
    // بدون ترخيص — وضع standalone (بدون قيود)
    _license = { valid: true, checked: true, standalone: true, permissions: _unlimitedPermissions() };
    logger.info('[License] وضع standalone — بدون قيود');
    return _license;
  }

  try {
    const result = await _post(server + '/api/license/verify', { licenseKey: key });
    if (result.valid) {
      _license = {
        valid:       true,
        checked:     true,
        standalone:  false,
        subscriber:  result.subscriber,
        daysLeft:    result.daysLeft,
        endDate:     result.endDate,
        permissions: result.permissions || _unlimitedPermissions(),
        error:       null,
      };
      logger.info(`[License] ✓ ${result.subscriber} — ${result.daysLeft} يوم متبقي`);
    } else {
      const reason = result.reason || result.error || 'غير صالح';
      _license = { valid: false, checked: true, error: reason, permissions: {} };
      logger.warn(`[License] ✗ ${reason}`);
    }
  } catch (e) {
    // لو ما قدر يتصل — استمر بآخر حالة معروفة
    logger.warn(`[License] فشل التحقق: ${e.message} — استمرار بالحالة السابقة`);
    if (!_license.checked) {
      _license = { valid: false, checked: true, error: 'تعذر الاتصال بسيرفر الترخيص', permissions: {} };
    }
  }
  return _license;
}

// ── الحصول على الصلاحيات ──────────────────────────────────────
function getLicense()      { return _license; }
function isValid()         { return _license.valid; }
function getPermissions()  { return _license.permissions || {}; }

function can(feature) {
  if (_license.standalone) return true;
  if (!_license.valid)     return false;
  const p = _license.permissions || {};
  const map = {
    ai:        p.aiEnabled,
    schedule:  p.scheduleEnabled,
    report:    p.reportEnabled,
    profiles:  p.profilesEnabled !== false,
    import:    p.bulkImport !== false,
  };
  return map[feature] !== false && map[feature] !== undefined ? !!map[feature] : true;
}

function getMaxAccounts(role) {
  if (_license.standalone) return 99999;
  const p = _license.permissions || {};
  const map = {
    post:    p.maxPostAccounts,
    engage:  p.maxEngageAccounts,
    support: p.maxSupportAccounts,
  };
  return map[role] || p.maxAccounts || 99999;
}

// ── HTTP helper ───────────────────────────────────────────────
function _post(url, body) {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const parsed  = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function _unlimitedPermissions() {
  return {
    maxAccounts: 99999, maxPostAccounts: 99999, maxEngageAccounts: 99999, maxSupportAccounts: 99999,
    aiEnabled: true, scheduleEnabled: true, reportEnabled: true, profilesEnabled: true, bulkImport: true,
  };
}

module.exports = { verifyLicense, getLicense, isValid, can, getPermissions, getMaxAccounts };