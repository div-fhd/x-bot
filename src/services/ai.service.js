'use strict';
const cfg    = require('../config');
const logger = require('../utils/logger');

let _client = null;

function getClient() {
  if (_client) return _client;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({ apiKey: cfg.ai.apiKey });
    return _client;
  } catch {
    throw new Error('حزمة @anthropic-ai/sdk غير مثبتة');
  }
}

async function ask(system, user, { maxTokens = 1000 } = {}) {
  const client = getClient();
  const r = await client.messages.create({
    model: cfg.ai.model, max_tokens: maxTokens,
    system, messages: [{ role: 'user', content: user }],
  });
  return r.content.map(b => b.text || '').join('');
}

async function askJSON(system, user, opts = {}) {
  const sys  = system + '\n\nأجب فقط بـ JSON صالح بدون أي نص إضافي أو Markdown.';
  const text = await ask(sys, user, opts);
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    throw new Error(`الذكاء الاصطناعي أعاد نصاً غير صالح: ${text.slice(0, 200)}`);
  }
}

const AISvc = {

  // ── اقتراح تغريدات ───────────────────────────────────────
  async suggestTweets({ niche, style = 'تعليمي', topic, count = 3, recentTweets = [] }) {
    const sys = `أنت كاتب محتوى محترف متخصص في تويتر/X باللغة العربية في مجال "${niche}".

قواعد صارمة:
- اكتب كإنسان حقيقي — بأسلوب طبيعي ومباشر
- لا تبدأ بـ "هل تعلم" أو "إليك" أو "تذكر" أو العبارات الإعلانية الجاهزة
- لا تكثر من علامات التعجب أو النقاط (!!! أو ...)
- لا تضع أكثر من هاشتاق واحد أو اثنين في نهاية التغريدة فقط
- الأسلوب: ${style}
- لا تتجاوز 260 حرفاً
- لا تكتب عبارات مثل "تابعنا" أو "اشترك" أو "تواصل معنا"
- تجنب الكلمات المبالغ فيها: "رائع، مذهل، خارق، لا يصدق"
${recentTweets.length ? `- تجنب تكرار هذه الأفكار: ${recentTweets.slice(0,5).join(' | ')}` : ''}`;

    const usr = `اكتب ${count} تغريدات${topic ? ` عن: ${topic}` : ` في مجال ${niche}`}.

أعدها بهذا الـ JSON:
[{"text":"نص التغريدة هنا","qualityScore":8.5,"riskScore":1.2,"note":"ملاحظة قصيرة"}]`;

    const r = await askJSON(sys, usr);
    return Array.isArray(r) ? r : (r.tweets || []);
  },

  // ── اقتراح ردود ──────────────────────────────────────────
  async suggestReplies({ originalTweet, niche, count = 2 }) {
    const sys = `أنت شخص حقيقي يتفاعل على تويتر في مجال "${niche}".

قواعد الرد الطبيعي:
- اردّ كإنسان عادي يقرأ التغريدة ويعلّق عليها
- الرد يجب أن يكون ذا صلة مباشرة بمحتوى التغريدة
- لا تبدأ بـ "بالتأكيد" أو "رائع" أو "شكراً على المشاركة" — هذه تبدو كسبام
- لا تضع هاشتاقات في الردود
- اكتب بلهجة محادثة طبيعية
- 1-2 جملة كحد أقصى (150 حرف)
- الرد يضيف قيمة أو رأياً أو سؤالاً ذكياً`;

    const usr = `التغريدة الأصلية: "${originalTweet}"

اكتب ${count} ردود مختلفة في الأسلوب والنبرة.
JSON: [{"text":"...","tone":"تعليق|سؤال|موافقة|إضافة","riskScore":0.5}]`;

    const r = await askJSON(sys, usr);
    return Array.isArray(r) ? r : (r.replies || []);
  },

  // ── تقييم محتوى ──────────────────────────────────────────
  async scoreContent(text, niche = '') {
    const sys = `أنت محكّم محتوى وسائل التواصل الاجتماعي. قيّم احتمال تصنيف المحتوى كـ spam.`;
    const usr = `التغريدة: "${text}"${niche ? `\nالمجال: ${niche}` : ''}
JSON: {"qualityScore":7.5,"riskScore":1.0,"flags":[],"suggestion":"...","recommendation":"موافق|مراجعة|رفض"}`;
    return askJSON(sys, usr);
  },

  // ── تحليل مخاطر ──────────────────────────────────────────
  async analyzeRisk({ username, recentActivity, plannedActions }) {
    const sys = `أنت محلل مخاطر لعمليات تويتر. كن متحفظاً في تقييماتك.`;
    const usr = `الحساب: @${username}
النشاط الأخير (ساعة): ${JSON.stringify(recentActivity)}
الإجراءات المخططة: ${JSON.stringify(plannedActions)}
JSON: {"riskLevel":"منخفض|متوسط|عالي","riskScore":3.2,"concerns":[],"recommendation":"تنفيذ|تقليل|إيقاف","safeActions":{"follow":10,"like":30}}`;
    return askJSON(sys, usr);
  },

  // ── اقتراح نبذة شخصية ────────────────────────────────────
  async suggestBio({ niche, name, keywords = [] }) {
    const sys = `اكتب نبذة شخصية لتويتر باللغة العربية. لا تتجاوز 160 حرفاً. اكتبها بأسلوب إنساني طبيعي.`;
    const usr = `المجال: ${niche}, الاسم: ${name}, الكلمات المفتاحية: ${keywords.join('، ')}
JSON: {"bio":"...","charCount":120}`;
    return askJSON(sys, usr);
  },
};

module.exports = AISvc;