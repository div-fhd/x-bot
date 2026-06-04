'use strict';
const Account = require('../models/Account');
const logger  = require('../utils/logger');
const { swallow } = require('../utils/swallow');

/**
 * تصنيف صحة الحساب تلقائياً من نتائج العمليات.
 *
 * إشارات قطعية (تُطبَّق فوراً): auth_required · checkpoint · suspended.
 * إشارة ناعمة (hysteresis): StillLoading المتكرر → limited (تقييد edge).
 * نجاح متحقّق → يستعيد active.
 *
 * أخطاء البروكسي/الشبكة/الـ selector عابرة → لا تُصنَّف كصحة حساب (تُتجاهَل هنا،
 * يتولّاها قاطع دائرة البروكسي).
 */
const LIMITED_THRESHOLD = 3;        // عدد StillLoading المتتالي قبل limited
const consec = new Map();           // accountId → عدّاد الإشارات الناعمة المتتالية

/** يحوّل رسالة خطأ إلى حُكم صحة، أو null لو ليست إشارة صحة. */
function classify(msg = '') {
  if (/auth_required|needs_auth|login wall|جدار تسجيل/i.test(msg)) return { status: 'auth_required' };
  if (/checkpoint|\/challenge|account\/access/i.test(msg))        return { status: 'checkpoint' };
  if (/\bsuspended\b/i.test(msg))                                 return { status: 'suspended' };
  if (/StillLoading/i.test(msg))                                  return { status: 'limited', soft: true };
  return null; // ProxyError / EmptyDocument / PageNotReady / ElementNotFound / timeout
}

async function recordFailure(accountId, errorMsg) {
  const v = classify(errorMsg);
  if (!v) return; // ليست إشارة صحة — لا نلمس العدّاد ولا الحالة
  const key = String(accountId);

  if (v.soft) {
    const n = (consec.get(key) || 0) + 1;
    consec.set(key, n);
    if (n < LIMITED_THRESHOLD) return; // لسّا ما بلغ العتبة
    consec.delete(key);
  } else {
    consec.delete(key);
  }

  const acc = await Account.findById(accountId).catch(() => null);
  if (acc) await _set(acc, v.status, errorMsg);
}

async function recordSuccess(accountId) {
  consec.delete(String(accountId));
  const acc = await Account.findById(accountId).catch(() => null);
  // نجاح متحقّق → استعد active لو كان في حالة متدهورة قابلة للتعافي
  if (acc && ['limited', 'auth_required', 'checkpoint', 'inactive'].includes(acc.status)) {
    await _set(acc, 'active', 'verified success');
  }
}

async function _set(acc, status, note) {
  if (acc.status === status) return; // لا تغيير
  const prev = acc.status;
  acc.status        = status;
  acc.lastCheckedAt = new Date();
  acc.statusNote    = `auto: ${String(note).slice(0, 150)}`;
  await acc.save().catch(swallow('health:save', 'warn'));
  logger.info(`[AccountHealth] @${acc.username}: ${prev} → ${status} (auto)`);
}

module.exports = { classify, recordFailure, recordSuccess };
