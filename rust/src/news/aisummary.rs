//! AI retelling of provider notices for the status slide, via OpenRouter. A
//! notice is written for a website — several paragraphs — while the slide has
//! room for a line or two.
//!
//! The model is asked only when a notice's ORIGINAL text changes: summaries
//! are cached per notice id with a hash of the text they came from, so a feed
//! polled every 15 minutes costs one request per new or edited notice. Without
//! a key, or when a call fails, the parser's own body is shown and the notice
//! is retried on the next poll.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::notices::ProviderNotice;
use crate::{fancy_regex, regex};

pub const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
/// Two lines of a provider card on the slide are ~170 characters.
pub const SUMMARY_MAX_CHARS: usize = 160;

const SYSTEM_PROMPT: &str = "Ты сокращаешь сообщения IPTV-провайдера для строки на экране телевизора. \
Перескажи сообщение одним коротким предложением на русском, не длиннее 120 символов. \
Оставь только суть: что не работает или какие идут работы, что затронуто (каналы, архив, приложение) и сроки, если они указаны. \
Не повторяй заголовок, без приветствий, извинений, благодарностей, эмодзи, кавычек и markdown. \
Ответь только самим текстом пересказа.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedSummary {
    pub hash: String,
    pub summary: String,
}

pub type SummaryCache = HashMap<String, CachedSummary>;

/// The text a summary is made from; its hash decides whether to ask again.
pub fn notice_source(n: &ProviderNotice) -> &str {
    if n.text.trim().is_empty() { n.body.trim() } else { n.text.trim() }
}

pub fn text_hash(text: &str) -> String {
    let mut h = hex::encode(Sha256::digest(text.as_bytes()));
    h.truncate(32);
    h
}

pub fn summary_messages(n: &ProviderNotice) -> Value {
    json!([
        { "role": "system", "content": SYSTEM_PROMPT },
        { "role": "user", "content": format!("Заголовок: {}\n\n{}", n.headline, notice_source(n)) },
    ])
}

/// Model output -> one clean line, clipped at a word boundary. Empty when
/// nothing usable is left.
pub fn clean_summary(raw: &str, max_chars: usize) -> String {
    let no_think = regex!(r"(?is)<think>.*?</think>").replace_all(raw, "");
    let first = regex!(r"\n\s*\n").split(&no_think).map(str::trim).find(|p| !p.is_empty()).unwrap_or("");
    let text = regex!(r"[*_`#>]+").replace_all(first, "");
    let text = fancy_regex!(r"[\p{Extended_Pictographic}\x{FE0F}\x{200D}]").replace_all(&text, "");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = regex!(r"(?i)^(?:кратко|пересказ|summary|итог)\s*[:—-]\s*").replace(&text, "");
    let text = regex!(r#"^["«„“']+|["»“”']+$"#).replace_all(&text, "");
    let text = text.trim();
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let cut: String = text.chars().take(max_chars - 1).collect();
    let head = match cut.rfind(' ') {
        Some(space) if cut[..space].chars().count() > max_chars / 2 => &cut[..space],
        _ => cut.as_str(),
    };
    format!("{}…", head.trim_end_matches([' ', ',', ';', ':', '—', '-']))
}

/// One OpenRouter call.
#[derive(Debug, Clone)]
pub struct AiClient<'a> {
    pub http: &'a reqwest::Client,
    pub api_key: &'a str,
    pub model: &'a str,
    pub timeout: Duration,
    pub url: &'a str,
}

impl AiClient<'_> {
    pub async fn summarize(&self, notice: &ProviderNotice) -> Result<String, String> {
        let body = json!({
            "model": self.model,
            "messages": summary_messages(notice),
            "temperature": 0.2,
            // Free routes often land on reasoning models that think before the
            // answer; a tight cap would leave the answer empty.
            "max_tokens": 1000,
            "reasoning": { "exclude": true },
        });
        let res = self
            .http
            .post(self.url)
            .bearer_auth(self.api_key)
            .header("X-Title", "IPTV info channel")
            .json(&body)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| format!("OpenRouter: {e}"))?;
        let status = res.status();
        let json: Option<Value> = res.json().await.ok();
        let error = json.as_ref().and_then(|j| j.get("error"));
        if !status.is_success() || error.is_some() {
            let detail = error
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map_or_else(|| format!("HTTP {}", status.as_u16()), str::to_owned);
            return Err(format!("OpenRouter: {detail}"));
        }
        let content = json
            .as_ref()
            .and_then(|j| j.pointer("/choices/0/message/content"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let summary = clean_summary(content, SUMMARY_MAX_CHARS);
        if summary.is_empty() { Err("OpenRouter: empty answer".to_owned()) } else { Ok(summary) }
    }
}

/// Outcome of [`apply_summaries`].
#[derive(Debug, Clone)]
pub struct Summarized {
    pub notices: Vec<ProviderNotice>,
    /// Only the ids still in the feed.
    pub cache: SummaryCache,
    pub error: Option<String>,
}

/// A notice whose text matches its cached hash reuses the summary; a new or
/// changed one is sent to the model. `client` = `None` means no key.
pub async fn apply_summaries(notices: Vec<ProviderNotice>, cache: &SummaryCache, client: Option<&AiClient<'_>>) -> Summarized {
    let Some(client) = client else { return Summarized { notices, cache: SummaryCache::new(), error: None } };
    let mut next = SummaryCache::new();
    let mut errors = Vec::new();
    let mut out = Vec::with_capacity(notices.len());
    for mut notice in notices {
        let hash = text_hash(notice_source(&notice));
        if let Some(cached) = cache.get(&notice.id).filter(|c| c.hash == hash && !c.summary.is_empty()) {
            notice.body.clone_from(&cached.summary);
            notice.ai = true;
            next.insert(notice.id.clone(), cached.clone());
            out.push(notice);
            continue;
        }
        match client.summarize(&notice).await {
            Ok(summary) => {
                next.insert(notice.id.clone(), CachedSummary { hash, summary: summary.clone() });
                notice.body = summary;
                notice.ai = true;
            }
            Err(e) => errors.push(e),
        }
        out.push(notice);
    }
    Summarized { notices: out, cache: next, error: errors.into_iter().next() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_model_output() {
        assert_eq!(clean_summary("**Кратко:** «Часть каналов недоступна до 18:00.»", 160), "Часть каналов недоступна до 18:00.");
        assert_eq!(clean_summary("<think>hmm</think>\n\nАрхив недоступен ⚠️\n\nВторой абзац", 160), "Архив недоступен");
        let long = clean_summary(&"слово ".repeat(60), 40);
        assert!(long.chars().count() <= 40 && long.ends_with('…'), "{long}");
        assert_eq!(clean_summary("   ", 160), "");
    }

    #[test]
    fn prompt_carries_headline_and_text() {
        let n = ProviderNotice { headline: "Технические работы".into(), text: "в течение нескольких часов".into(), ..ProviderNotice::default() };
        let m = summary_messages(&n);
        assert_eq!(m[0]["role"], "system");
        let user = m[1]["content"].as_str().unwrap();
        assert!(user.contains("Заголовок: Технические работы") && user.contains("в течение нескольких часов"));
    }

    #[tokio::test]
    async fn without_key_nothing_changes() {
        let n = ProviderNotice { id: "1".into(), body: "b".into(), ..ProviderNotice::default() };
        let mut cache = SummaryCache::new();
        cache.insert("1".into(), CachedSummary { hash: "x".into(), summary: "y".into() });
        let out = apply_summaries(vec![n.clone()], &cache, None).await;
        assert_eq!(out.notices, [n]);
        assert!(out.cache.is_empty());
    }
}
