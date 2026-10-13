//! Provider service notices on the status slide: settings, fetching and the
//! polling watcher. Parsing/classification is pure and lives in `notices`.
//!
//! The feed sits behind the provider's web login (a cookie session). The admin
//! pastes the browser's Cookie header once; on 401/403 the watcher calls the
//! site's `/v3/auth/refresh` with that jar and persists whatever cookies come
//! back, so a rotated session keeps working.
//!
//! Stored under Settings `provider_news` (`enabled, url, cookie, ai_key,
//! notices, summaries`). The cookie and the API key are credentials: never
//! hand the raw settings to a client.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use reqwest::header::{ACCEPT, COOKIE, HeaderMap, HeaderValue, ORIGIN, REFERER, SET_COOKIE, USER_AGENT};
use serde_json::{Map, Value, json};
use tokio::sync::Mutex as AsyncMutex;

use super::aisummary::{AiClient, OPENROUTER_URL, SummaryCache, apply_summaries};
use super::notices::{ProviderNotice, active_notices, apply_set_cookies, extract_service_notices};
use crate::config::Config;
use crate::core::fetch::read_bounded;
use crate::core::util::{iso_now, now_ms};
use crate::data::store::Store;

const SETTINGS_KEY: &str = "provider_news";
/// A news page is a few kilobytes; anything near this is the wrong URL.
const MAX_BYTES: usize = 2 * 1024 * 1024;
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/// The admin's values overlaid on the env defaults.
#[derive(Debug, Clone)]
pub struct NewsSettings {
    pub enabled: bool,
    pub url: String,
    pub cookie: String,
    pub ai_key: String,
    pub notices: Vec<ProviderNotice>,
    pub summaries: SummaryCache,
}

/// A validated admin patch (`validateProviderNews`).
#[derive(Debug, Clone, Default)]
pub struct NewsPatch {
    pub enabled: Option<bool>,
    pub url: Option<String>,
    pub cookie: Option<String>,
    pub ai_key: Option<String>,
}

#[derive(Debug, Default)]
struct Runtime {
    checked_at: Option<String>,
    error: Option<String>,
    auth_failed: bool,
    ai_error: Option<String>,
}

#[derive(Debug)]
pub struct ProviderNews {
    config: Arc<Config>,
    store: Arc<Store>,
    http: reqwest::Client,
    runtime: Mutex<Runtime>,
    last_shown: Mutex<Option<String>>,
    /// One fetch at a time.
    running: AsyncMutex<()>,
    /// Overridable for tests.
    ai_url: String,
}

#[derive(Debug, thiserror::Error)]
enum FetchFailure {
    #[error("provider rejected the session ({0})")]
    Auth(u16),
    #[error("{0}")]
    Other(String),
}

impl ProviderNews {
    pub fn new(config: Arc<Config>, store: Arc<Store>, http: reqwest::Client) -> Self {
        Self::with_ai_url(config, store, http, OPENROUTER_URL.to_owned())
    }

    pub fn with_ai_url(config: Arc<Config>, store: Arc<Store>, http: reqwest::Client, ai_url: String) -> Self {
        Self {
            config,
            store,
            http,
            runtime: Mutex::default(),
            last_shown: Mutex::default(),
            running: AsyncMutex::new(()),
            ai_url,
        }
    }

    fn stored(&self) -> Map<String, Value> {
        self.store.setting(SETTINGS_KEY).and_then(|v| v.as_object().cloned()).unwrap_or_default()
    }

    fn save(&self, patch: Map<String, Value>) {
        let mut s = self.stored();
        s.extend(patch);
        if let Err(e) = self.store.set_setting(SETTINGS_KEY, Value::Object(s)) {
            tracing::error!(target: "provider-news", error = %e, "saving settings failed");
        }
    }

    fn runtime(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn settings(&self) -> NewsSettings {
        let s = self.stored();
        let env = &self.config.provider_news;
        let text = |k: &str| s.get(k).and_then(Value::as_str);
        NewsSettings {
            enabled: s.get("enabled").and_then(Value::as_bool).unwrap_or(env.enabled),
            url: text("url").filter(|u| !u.is_empty()).unwrap_or(&env.url).to_owned(),
            cookie: text("cookie").unwrap_or(&env.cookie).to_owned(),
            ai_key: text("ai_key").filter(|k| !k.is_empty()).unwrap_or(&env.ai_key).to_owned(),
            notices: s.get("notices").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default(),
            summaries: s.get("summaries").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default(),
        }
    }

    pub fn update_settings(&self, patch: NewsPatch) {
        let mut out = Map::new();
        if let Some(v) = patch.enabled {
            out.insert("enabled".into(), json!(v));
        }
        if let Some(url) = &patch.url {
            out.insert("url".into(), json!(url));
            // A different feed makes the stored notices meaningless.
            let effective = if url.is_empty() { &self.config.provider_news.url } else { url };
            if *effective != self.settings().url {
                out.insert("notices".into(), json!([]));
                out.insert("summaries".into(), json!({}));
            }
        }
        if let Some(cookie) = patch.cookie {
            out.insert("cookie".into(), json!(cookie));
            self.runtime().auth_failed = false;
        }
        if let Some(key) = patch.ai_key {
            out.insert("ai_key".into(), json!(key));
            self.runtime().ai_error = None;
        }
        self.save(out);
    }

    /// What the status slide shows right now (empty when the feature is off).
    pub fn current_notices(&self) -> Vec<ProviderNotice> {
        let s = self.settings();
        if !s.enabled {
            return Vec::new();
        }
        active_notices(&s.notices, jiff::Timestamp::now(), self.config.provider_news.max_age_hours)
    }

    /// The status slide is global, so any change to what it shows means a
    /// rebuild of every stream. The first caller to see a change gets `true`.
    pub fn consume_shown_change(&self) -> bool {
        let key = serde_json::to_string(
            &self.current_notices().iter().map(|n| (&n.id, &n.headline, &n.body)).collect::<Vec<_>>(),
        )
        .unwrap_or_default();
        let mut last = self.last_shown.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = last.as_ref().is_some_and(|prev| *prev != key);
        *last = Some(key);
        changed
    }

    async fn request(&self, url: &str, post: bool, cookie: &str) -> Result<reqwest::Response, String> {
        let origin = url::Url::parse(url).map_err(|e| e.to_string())?.origin().ascii_serialization();
        let mut headers = HeaderMap::new();
        headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_UA));
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert("X-Requested-With", HeaderValue::from_static("XMLHttpRequest"));
        if let Ok(v) = HeaderValue::from_str(&origin) {
            headers.insert(ORIGIN, v);
        }
        if let Ok(v) = HeaderValue::from_str(&format!("{origin}/")) {
            headers.insert(REFERER, v);
        }
        if !cookie.is_empty()
            && let Ok(v) = HeaderValue::from_str(cookie)
        {
            headers.insert(COOKIE, v);
        }
        let builder = if post { self.http.post(url) } else { self.http.get(url) };
        builder
            .headers(headers)
            .timeout(Duration::from_millis(self.config.provider_news.timeout_ms))
            .send()
            .await
            .map_err(|e| e.to_string())
    }

    fn set_cookies(res: &reqwest::Response) -> Vec<String> {
        res.headers().get_all(SET_COOKIE).iter().filter_map(|v| v.to_str().ok().map(str::to_owned)).collect()
    }

    async fn fetch_notices(&self) -> Result<Vec<ProviderNotice>, FetchFailure> {
        let s = self.settings();
        let mut cookie = s.cookie.clone();
        let mut res = self.request(&s.url, false, &cookie).await.map_err(FetchFailure::Other)?;
        cookie = apply_set_cookies(&cookie, &Self::set_cookies(&res), now_ms());
        let is_auth = |r: &reqwest::Response| matches!(r.status().as_u16(), 401 | 403);

        if is_auth(&res) && !cookie.is_empty() {
            let refresh_url = if self.config.provider_news.refresh_url.is_empty() {
                url::Url::parse(&s.url).and_then(|u| u.join("/v3/auth/refresh")).map(String::from).unwrap_or_default()
            } else {
                self.config.provider_news.refresh_url.clone()
            };
            let refreshed = self.request(&refresh_url, true, &cookie).await.map_err(FetchFailure::Other)?;
            cookie = apply_set_cookies(&cookie, &Self::set_cookies(&refreshed), now_ms());
            if refreshed.status().is_success() {
                res = self.request(&s.url, false, &cookie).await.map_err(FetchFailure::Other)?;
                cookie = apply_set_cookies(&cookie, &Self::set_cookies(&res), now_ms());
            }
        }
        // Persist a rotated session even when the request itself failed.
        if cookie != s.cookie {
            let mut patch = Map::new();
            patch.insert("cookie".into(), json!(cookie));
            self.save(patch);
        }
        if is_auth(&res) {
            return Err(FetchFailure::Auth(res.status().as_u16()));
        }
        if !res.status().is_success() {
            return Err(FetchFailure::Other(format!("provider responded {}", res.status().as_u16())));
        }
        let body = read_bounded(res, MAX_BYTES, false)
            .await
            .map_err(|e| FetchFailure::Other(format!("news response: {e}")))?;
        let json: Value =
            serde_json::from_slice(&body.body).map_err(|_| FetchFailure::Other("news response is not JSON".to_owned()))?;
        Ok(extract_service_notices(&json, &self.config.tz, "RU", 5))
    }

    async fn summarize(&self, notices: Vec<ProviderNotice>) -> Vec<ProviderNotice> {
        let s = self.settings();
        let cfg = &self.config.provider_news;
        let client = (!s.ai_key.is_empty()).then(|| AiClient {
            http: &self.http,
            api_key: &s.ai_key,
            model: &cfg.ai_model,
            timeout: Duration::from_millis(cfg.ai_timeout_ms),
            url: &self.ai_url,
        });
        let out = apply_summaries(notices, &s.summaries, client.as_ref()).await;
        if out.cache != s.summaries {
            let mut patch = Map::new();
            patch.insert("summaries".into(), json!(out.cache));
            self.save(patch);
        }
        if let Some(e) = &out.error {
            tracing::warn!(target: "provider-news", error = %e, "AI summary failed");
        }
        self.runtime().ai_error = out.error;
        out.notices
    }

    /// Fetch now. A failure keeps the previous notices (a provider hiccup must
    /// not wipe a real maintenance notice); they still age out on their own.
    pub async fn refresh(&self) -> Option<String> {
        let _guard = self.running.lock().await;
        let result = match self.fetch_notices().await {
            Ok(notices) => {
                let notices = self.summarize(notices).await;
                if notices != self.settings().notices {
                    tracing::info!(target: "provider-news", notices = notices.len(), newest = ?notices.first().map(|n| &n.headline), "service notices updated");
                    let mut patch = Map::new();
                    patch.insert("notices".into(), json!(notices));
                    self.save(patch);
                }
                Ok(())
            }
            Err(e) => Err(e),
        };
        let mut rt = self.runtime();
        rt.checked_at = Some(iso_now());
        match result {
            Ok(()) => {
                rt.error = None;
                rt.auth_failed = false;
            }
            Err(e) => {
                tracing::warn!(target: "provider-news", error = %e, "fetch failed");
                rt.auth_failed = matches!(e, FetchFailure::Auth(_));
                rt.error = Some(e.to_string());
            }
        }
        rt.error.clone()
    }

    /// The admin card's view: whether a cookie / key is set, never them.
    pub fn view(&self) -> Value {
        let s = self.settings();
        let shown: Vec<String> = self.current_notices().into_iter().map(|n| n.id).collect();
        let rt = self.runtime();
        let env = &self.config.provider_news;
        let notices: Vec<Value> = s
            .notices
            .iter()
            .map(|n| {
                let mut v = json!(n);
                v["active"] = json!(shown.contains(&n.id));
                v
            })
            .collect();
        json!({
            "enabled": s.enabled,
            "url": s.url,
            "default_url": env.url,
            "cookie_set": !s.cookie.is_empty(),
            "ai_key_set": !s.ai_key.is_empty(),
            "ai_key_from_env": !env.ai_key.is_empty() && self.stored().get("ai_key").and_then(Value::as_str).is_none_or(str::is_empty),
            "ai_model": env.ai_model,
            "ai_error": rt.ai_error,
            "checked_at": rt.checked_at,
            "error": rt.error,
            "auth_failed": rt.auth_failed,
            "check_minutes": env.check_minutes,
            "max_age_hours": env.max_age_hours,
            "notices": notices,
        })
    }

    /// Poll the feed and call `on_change` whenever what the slide shows
    /// changes — including a notice ageing out between fetches.
    pub fn start_watcher(self: &Arc<Self>, on_change: impl Fn() + Send + Sync + 'static) {
        let me = Arc::clone(self);
        let every = Duration::from_secs(me.config.provider_news.check_minutes.max(1) * 60);
        me.consume_shown_change(); // baseline: what the streams were just built with
        tracing::info!(target: "provider-news", check_every_minutes = every.as_secs() / 60, "watcher started");
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            loop {
                tick.tick().await;
                if me.settings().enabled {
                    me.refresh().await;
                }
                if me.consume_shown_change() {
                    on_change();
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::http::{HeaderMap as AxHeaders, StatusCode};
    use axum::response::{AppendHeaders, IntoResponse};
    use axum::routing::{get, post};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const FEED: &str = r#"{"data":{"items":[
        {"id":1,"date":"14.09.2026 13:06:44","html":"<p>🇷🇺 RU ⚠️ Технические работы! Часть телеканалов будет временно недоступна.</p>","isPublished":true},
        {"id":2,"date":"13.09.2026 10:00:00","html":"<p>Новый канал с 13 сентября!</p>","isPublished":true}]}}"#;

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn news(dir: &std::path::Path, ai_url: String) -> ProviderNews {
        let mut config = Config::load(dir.to_path_buf());
        config.provider_news.ai_key = String::new();
        config.provider_news.max_age_hours = 1e9;
        let store = Arc::new(Store::open(dir).unwrap());
        ProviderNews::with_ai_url(Arc::new(config), store, reqwest::Client::new(), ai_url)
    }

    #[tokio::test]
    async fn refreshes_session_on_401_and_persists_cookie() {
        let hits = Arc::new(AtomicUsize::new(0));
        let h = Arc::clone(&hits);
        let app = Router::new()
            .route(
                "/v3/news",
                get(move |headers: AxHeaders| {
                    let n = h.fetch_add(1, Ordering::SeqCst);
                    async move {
                        let cookie = headers.get("cookie").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
                        if n == 0 {
                            assert_eq!(cookie, "access=old; refresh=r1");
                            return (StatusCode::UNAUTHORIZED, "{}").into_response();
                        }
                        assert_eq!(cookie, "access=new; refresh=r2");
                        ([("content-type", "application/json")], FEED).into_response()
                    }
                }),
            )
            .route(
                "/v3/auth/refresh",
                post(|| async { (AppendHeaders([("set-cookie", "access=new; Path=/"), ("set-cookie", "refresh=r2; Path=/")]), "{}") }),
            );
        let base = serve(app).await;
        let dir = tempfile::tempdir().unwrap();
        let n = news(dir.path(), String::new());
        n.store
            .set_setting(SETTINGS_KEY, json!({"enabled": true, "url": format!("{base}/v3/news?page=1"), "cookie": "access=old; refresh=r1"}))
            .unwrap();
        assert_eq!(n.refresh().await, None);
        assert_eq!(n.settings().cookie, "access=new; refresh=r2");
        assert_eq!(n.current_notices().iter().map(|x| x.headline.as_str()).collect::<Vec<_>>(), ["Технические работы"]);
        let view = n.view();
        assert_eq!(view["cookie_set"], true);
        assert!(view.get("cookie").is_none());
        assert_eq!(view["notices"][0]["active"], true);
    }

    #[tokio::test]
    async fn failure_keeps_notices_and_disabling_hides_them() {
        let app = Router::new().route("/v3/news", get(|| async { (StatusCode::BAD_GATEWAY, "oops") }));
        let base = serve(app).await;
        let dir = tempfile::tempdir().unwrap();
        let n = news(dir.path(), String::new());
        let notice = ProviderNotice { id: "1".into(), published_at: iso_now(), headline: "x".into(), ..ProviderNotice::default() };
        n.store.set_setting(SETTINGS_KEY, json!({"enabled": true, "url": format!("{base}/v3/news"), "notices": [notice]})).unwrap();
        assert!(n.refresh().await.unwrap().contains("502"));
        assert_eq!(n.current_notices().len(), 1);
        n.update_settings(NewsPatch { enabled: Some(false), ..NewsPatch::default() });
        assert!(n.current_notices().is_empty());
        n.update_settings(NewsPatch { enabled: Some(true), url: Some("https://other.example/news".into()), ..NewsPatch::default() });
        assert!(n.settings().notices.is_empty());
    }

    #[tokio::test]
    async fn ai_summary_asked_once_per_text() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = Arc::clone(&calls);
        let app = Router::new()
            .route("/v3/news", get(|| async { ([("content-type", "application/json")], FEED) }))
            .route(
                "/ai",
                post(move || {
                    c.fetch_add(1, Ordering::SeqCst);
                    async { axum::Json(json!({"choices":[{"message":{"content":"Часть каналов временно недоступна."}}]})) }
                }),
            );
        let base = serve(app).await;
        let dir = tempfile::tempdir().unwrap();
        let n = news(dir.path(), format!("{base}/ai"));
        n.store
            .set_setting(SETTINGS_KEY, json!({"enabled": true, "url": format!("{base}/v3/news"), "cookie": "a=1", "ai_key": "sk-or-test"}))
            .unwrap();
        assert_eq!(n.refresh().await, None);
        let shown = n.current_notices();
        assert_eq!(shown[0].body, "Часть каналов временно недоступна.");
        assert!(shown[0].ai && shown[0].text.contains("Технические работы"));
        n.refresh().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let view = n.view();
        assert_eq!(view["ai_key_set"], true);
        assert!(!view.to_string().contains("sk-or-test"));
    }
}
