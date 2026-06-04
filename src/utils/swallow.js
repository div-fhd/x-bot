'use strict';
const logger = require('./logger');

/**
 * بديل آمن لـ `.catch(() => {})` الأعمى.
 *
 * يبلع الاستثناء (حتى لا يكسر التدفّق) **لكن يترك أثراً قابلاً للتتبّع** —
 * فلا خطأ يختفي بصمت بعد الآن. استخدمه هكذا:
 *
 *   await page.close().catch(swallow('like:closePage'));            // افتراضي: debug
 *   await account.bump('like').catch(swallow('like:bump', 'warn')); // حرج: warn
 *
 * @param {string} context  وصف قصير: "العملية:الخطوة" — يظهر في السجل.
 * @param {'debug'|'warn'|'error'} level  مستوى التسجيل (افتراضي debug).
 */
function swallow(context, level = 'debug') {
  return (e) => {
    const msg = e && e.message ? e.message : String(e);
    (logger[level] || logger.debug)(`[swallow] ${context}: ${msg}`);
  };
}

module.exports = { swallow };
