// AI retelling of provider notices for the status slide. A provider notice is
// written for a website — several paragraphs — while the slide has room for a
// line or two, so an LLM on OpenRouter shrinks it to one short sentence.
//
// The model is only asked when a notice's ORIGINAL text changes: summaries are
// cached per notice id together with a hash of the text they were made from
// (Settings `provider_news.summaries`), so a feed polled every 15 minutes costs
// one request per new or edited notice, not one per poll. Without a key, or when
// the call fails, the parser's own body (notices.js summarizeNotice) is shown,
// and a failed notice is retried on the next poll.
import crypto from 'node:crypto';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'openrouter/free';
// Two lines of a provider card on the slide are ~170 characters.
export const SUMMARY_MAX_CHARS = 160;

const SYSTEM_PROMPT = [
  'Ты сокращаешь сообщения IPTV-провайдера для строки на экране телевизора.',
  'Перескажи сообщение одним коротким предложением на русском, не длиннее 120 символов.',
  'Оставь только суть: что не работает или какие идут работы, что затронуто (каналы, архив, приложение) и сроки, если они указаны.',
  'Не повторяй заголовок, без приветствий, извинений, благодарностей, эмодзи, кавычек и markdown.',
  'Ответь только самим текстом пересказа.',
].join(' ');

// The text a summary is made from; its hash decides whether to ask again.
export const noticeSource = (notice) => String(notice?.text || notice?.body || '').trim();

export function textHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 32);
}

export function summaryMessages(notice) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Заголовок: ${notice?.headline || ''}\n\n${noticeSource(notice)}` },
  ];
}

// Model output -> one clean line: no markdown, quotes, "Кратко:" lead-ins or
// emoji, clipped at a word boundary. '' when nothing usable is left.
export function cleanSummary(raw, maxChars = SUMMARY_MAX_CHARS) {
  let text = String(raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(Boolean) || '';
  text = text
    .replace(/[*_`#>]+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:кратко|пересказ|summary|итог)\s*[:—-]\s*/iu, '')
    .replace(/^["«„“']+|["»“”']+$/gu, '')
    .trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxChars / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/u, '')}…`;
}

export async function summarizeNotice(notice, {
  apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch, timeoutMs = 30_000, url = OPENROUTER_URL,
}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'IPTV info channel',
    },
    body: JSON.stringify({
      model,
      messages: summaryMessages(notice),
      temperature: 0.2,
      // Free routes often land on reasoning models, which spend tokens thinking
      // before the answer; a tight cap would leave the answer empty.
      max_tokens: 1000,
      reasoning: { exclude: true },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await res.json(); } catch { /* reported below */ }
  if (!res.ok || json?.error) {
    const detail = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenRouter: ${detail}`);
  }
  const summary = cleanSummary(json?.choices?.[0]?.message?.content);
  if (!summary) throw new Error('OpenRouter: empty answer');
  return summary;
}

// notices + cache -> { notices, cache, error }. A notice whose text matches its
// cached hash reuses the summary; a new or changed one is sent to the model.
// The returned cache holds only the ids still in the feed.
export async function applySummaries(notices, cache = {}, { apiKey, ...options } = {}) {
  const list = Array.isArray(notices) ? notices : [];
  if (!apiKey) return { notices: list, cache: {}, error: null };
  const next = {};
  const errors = [];
  const out = [];
  for (const notice of list) {
    const hash = textHash(noticeSource(notice));
    const cached = cache?.[notice.id];
    if (cached?.hash === hash && cached.summary) {
      next[notice.id] = cached;
      out.push({ ...notice, body: cached.summary, ai: true });
      continue;
    }
    try {
      const summary = await summarizeNotice(notice, { apiKey, ...options });
      next[notice.id] = { hash, summary };
      out.push({ ...notice, body: summary, ai: true });
    } catch (e) {
      errors.push(e.message);
      out.push(notice);
    }
  }
  return { notices: out, cache: next, error: errors[0] || null };
}
