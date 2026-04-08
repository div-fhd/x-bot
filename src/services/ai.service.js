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

  // ── اقتراح محتوى ────────────────────────────────────────
  async suggestTweets({ niche, style = 'تعليمي', topic, count = 3, recentTweets = [] }) {
    const sys = `أنت متخصص في إدارة حسابات تويتر باللغة العربية في مجال ${niche}.
الأسلوب: ${style}. القواعد: لا تتجاوز 280 حرفاً، لا تكثر من الهاشتاقات (2 كحد أقصى).
${recentTweets.length ? `تجنب تكرار هذه الأفكار: ${recentTweets.slice(0,5).join(' | ')}` : ''}`;

    const usr = `اقترح ${count} تغريد${count > 1 ? 'ات' : 'ة'} ${topic ? `عن هذا الموضوع تحديداً: "${topic}"` : ''}.
مهم جداً: التزم بالموضوع المحدد ولا تخرج عنه.
الرد يجب أن يكون JSON فقط: [{"text":"...","qualityScore":8.5,"riskScore":1.2,"note":"..."}]`;

    const r = await askJSON(sys, usr);
    return Array.isArray(r) ? r : (r.tweets || []);
  },

  // ── اقتراح ردود ─────────────────────────────────────────
  async suggestReplies({ originalTweet, niche, count = 2 }) {
    const sys = `أنت مدير حساب تويتر في مجال ${niche}. اكتب ردوداً مختصرة ومفيدة (240 حرفاً كحد أقصى).`;
    const usr = `التغريدة: "${originalTweet}"\nاقترح ${count} رداً.\nJSON: [{"text":"...","tone":"...","riskScore":0.5}]`;
    const r   = await askJSON(sys, usr);
    return Array.isArray(r) ? r : (r.replies || []);
  },

  // ── تقييم محتوى ─────────────────────────────────────────
  async scoreContent(text, niche = '') {
    const sys = `أنت محكّم محتوى وسائل التواصل الاجتماعي.`;
    const usr = `قيّم هذه التغريدة: "${text}"${niche ? `\nالمجال: ${niche}` : ''}
JSON: {"qualityScore":7.5,"riskScore":1.0,"flags":[],"suggestion":"...","recommendation":"موافق|مراجعة|رفض"}`;
    return askJSON(sys, usr);
  },

  // ── تحليل مخاطر ─────────────────────────────────────────
  async analyzeRisk({ username, recentActivity, plannedActions }) {
    const sys = `أنت محلل مخاطر لعمليات تويتر. كن متحفظاً في تقييماتك.`;
    const usr = `الحساب: @${username}
النشاط الأخير (ساعة): ${JSON.stringify(recentActivity)}
الإجراءات المخطوطة: ${JSON.stringify(plannedActions)}
JSON: {"riskLevel":"منخفض|متوسط|عالي","riskScore":3.2,"concerns":[],"recommendation":"تنفيذ|تقليل|إيقاف","safeActions":{"follow":10,"like":30}}`;
    return askJSON(sys, usr);
  },

  // ── اقتراح نبذة شخصية ────────────────────────────────────
  async suggestBio({ niche, name, keywords = [] }) {
    const sys = `اكتب نبذة شخصية لتويتر باللغة العربية. لا تتجاوز 160 حرفاً.`;
    const usr = `المجال: ${niche}, الاسم: ${name}, الكلمات المفتاحية: ${keywords.join('، ')}
JSON: {"bio":"...","charCount":120}`;
    return askJSON(sys, usr);
  },
};

module.exports = AISvc;