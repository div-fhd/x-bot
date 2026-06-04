'use strict';
/**
 * طبقة تفاعل DOM لـ X — لغة-محايدة، مبنية على السجل المركزي (./selectors).
 *
 * المبدأ: كل فشل **صريح** — يسمّي العنصر المنطقي ويذكر البدائل التي جُرّبت.
 * ولا "نجاح بلا دليل": الأفعال تتحقّق من تغيّر الـ DOM بعد التنفيذ.
 */
const { sleep } = require('../utils/delay');

const arr = (c) => (Array.isArray(c) ? c : [c]);

/**
 * يحلّ أول بديل مطابق → يُرجع Playwright Locator.
 * يرمي خطأً واضحاً يسمّي العنصر وكل البدائل المُجرّبة.
 */
async function resolve(page, name, candidates, { state = 'visible', timeout = 15_000 } = {}) {
  const list = arr(candidates);
  let matched = null;
  try {
    matched = await Promise.any(
      list.map((sel) => page.waitForSelector(sel, { state, timeout }).then(() => sel)),
    );
  } catch { matched = null; }
  if (!matched) {
    throw new Error(`ElementNotFound[${name}]: جُرّبت ${list.length} بدائل → ${list.join('  |  ')}`);
  }
  return page.locator(matched).first();
}

/**
 * فحص وجود (بوليان) — لا يرمي أبداً. يُرجع true لو طابق أي بديل.
 */
async function present(page, candidates, { timeout = 5_000, state = 'attached' } = {}) {
  const list = arr(candidates);
  try {
    return await Promise.any(
      list.map((sel) => page.waitForSelector(sel, { state, timeout }).then(() => true)),
    );
  } catch { return false; }
}

/**
 * يضغط عنصراً ثم **يتحقّق** من ظهور الحالة المتوقّعة بعده.
 * يرمي ActionUnverified لو الضغط لم يُنتج التغيّر المطلوب — لا نجاح كاذب.
 */
async function clickVerified(page, { name, target, verify, settle = [800, 1500], verifyTimeout = 8_000 }) {
  const el = await resolve(page, name, target);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.evaluate((node) => node.click());
  await sleep(settle[0], settle[1]);
  if (verify) {
    const ok = await present(page, verify, { timeout: verifyTimeout });
    if (!ok) throw new Error(`ActionUnverified[${name}]: تم الضغط لكن الحالة المتوقّعة لم تظهر`);
  }
  return true;
}

/**
 * يؤكّد أن صفحة التغريدة رسمت شريط الأفعال فعلاً (ليست فاضية/login/محدودة).
 * يميّز جدار تسجيل الدخول عن الفشل العام — تشخيص أوضح بدل timeout غامض.
 */
async function assertTweetReady(page, SEL, account) {
  const ready = await present(page, SEL.tweet.actionBar, { timeout: 20_000, state: 'visible' });
  if (ready) return true;
  if (await present(page, SEL.page.loginWall, { timeout: 1_500 })) {
    throw new Error(`SKIP:@${account?.username} — needs_auth (جدار تسجيل دخول على صفحة التغريدة)`);
  }
  throw new Error(`PageNotReady: شريط أفعال التغريدة لم يُرسم`);
}

module.exports = { resolve, present, clickVerified, assertTweetReady };
