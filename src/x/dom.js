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

// أخطاء شبكة/بروكسي شائعة من Chromium — نصنّفها برسالة واضحة بدل بلعها
const NET_ERR = /ERR_(PROXY|TUNNEL|TIMED_OUT|CONNECTION_(RESET|REFUSED|CLOSED|FAILED|ABORTED)|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|SOCKS|EMPTY_RESPONSE|NETWORK_CHANGED|INTERNET_DISCONNECTED)/i;

/**
 * تنقّل آمن: بدل `page.goto(...).catch(()=>{})` الذي يبلع فشل البروكسي،
 * نلتقط الخطأ ونصنّفه — فشل الشبكة/البروكسي يظهر صريحاً فوراً.
 */
async function navigate(page, url, { waitUntil = 'domcontentloaded', timeout = 60_000 } = {}) {
  let resp;
  try {
    resp = await page.goto(url, { waitUntil, timeout });
  } catch (e) {
    const m = String(e.message).match(NET_ERR);
    if (m) throw new Error(`ProxyError: فشل التنقّل — ${m[0]}`); // خطأ شبكة/بروكسي حقيقي
    throw e; // خطأ آخر (timeout تحميل، إلخ) يمرّ كما هو
  }
  // صنّف استجابة X — يحسم السبب بدل التخمين
  const status = resp ? resp.status() : 0;
  if (!resp)            throw new Error(`NavError: لا استجابة من X (إلغاء/إعادة توجيه غير قابلة للتنقّل)`);
  if (status === 429)   throw new Error(`RateLimited: X رجّع 429 (تجاوز معدّل) — أبطئ/بدّل البروكسي`);
  if (status === 403)   throw new Error(`Forbidden: X رجّع 403 (محظور — مصادقة/IP)`);
  if (status >= 400)    throw new Error(`HttpError: X رجّع ${status}`);
  return resp; // 2xx/3xx — الحالة متاحة عبر resp.status() للمتصل
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
    throw new Error(`SKIP:@${account?.username} — auth_required (جدار تسجيل دخول على صفحة التغريدة)`);
  }
  // مستند فارغ/شبه فارغ (لا react-root، HTML ضئيل) = X رجّع جسم فارغ.
  // محايد عمداً — السبب قد يكون بروكسي/حظر edge/الحساب. status من navigate يحسمه.
  const htmlLen = await page.evaluate(() => document.documentElement.outerHTML.length).catch(() => 0);
  if (htmlLen < 600) {
    throw new Error(`EmptyDocument: @${account?.username} — مستند فارغ (${htmlLen}b) — X لم يرجّع محتوى (راجع status من navigate)`);
  }
  throw new Error(`PageNotReady: شريط أفعال التغريدة لم يُرسم (htmlLen=${htmlLen})`);
}

module.exports = { resolve, present, navigate, clickVerified, assertTweetReady };
