'use strict';
const logger = require('../utils/logger');

/**
 * قاطع دائرة لكل حساب — يحمي من طرق بروكسي/شبكة ميّتة بشكل متكرر.
 *
 * المنطق: بعد N فشل بروكسي/شبكة متتالٍ لحساب → نفتح الدائرة (نتخطّاه) لفترة تبريد.
 * أي نجاح يعيد الضبط فوراً. يمنع: إهدار الوقت على بروكسي ميّت + الطرق المتكرر
 * الذي قد يثير الحظر.
 *
 * في الذاكرة (تكفي — البروكسي الميّت يُكتشف بسرعة). يُعاد الضبط عند إعادة التشغيل.
 */
const FAILS_TO_OPEN = 3;             // عدد الفشل المتتالي قبل فتح الدائرة
const COOLDOWN_MS    = 10 * 60_000;  // مدة التبريد (١٠ دقائق)

const state = new Map();             // accountId → { fails, openUntil }

/** سجّل نتيجة محاولة: ok=true يعيد الضبط، false يزيد العدّاد وقد يفتح الدائرة. */
function record(accountId, ok) {
  const key = String(accountId);
  if (ok) { state.delete(key); return; }

  const s = state.get(key) || { fails: 0, openUntil: 0 };
  s.fails += 1;
  if (s.fails >= FAILS_TO_OPEN) {
    s.openUntil = Date.now() + COOLDOWN_MS;
    logger.warn(`[ProxyBreaker] ${key} — الدائرة مفتوحة بعد ${s.fails} فشل، تبريد ${COOLDOWN_MS / 60000}د`);
  }
  state.set(key, s);
}

/** يرمي SKIP إذا كانت دائرة الحساب مفتوحة (في تبريد). يُستدعى قبل أي عملية. */
function assert(account) {
  const s = state.get(String(account._id));
  if (s && s.openUntil > Date.now()) {
    const mins = Math.ceil((s.openUntil - Date.now()) / 60000);
    throw new Error(`SKIP:@${account.username} — proxy circuit open (${s.fails} فشل متتالٍ، تبريد ${mins}د)`);
  }
}

/** للوحة التحكم/التشخيص: الحسابات المفتوحة دائرتها حالياً. */
function snapshot() {
  const now = Date.now();
  return [...state.entries()]
    .filter(([, s]) => s.openUntil > now)
    .map(([id, s]) => ({ accountId: id, fails: s.fails, cooldownMs: s.openUntil - now }));
}

module.exports = { record, assert, snapshot, FAILS_TO_OPEN, COOLDOWN_MS };
