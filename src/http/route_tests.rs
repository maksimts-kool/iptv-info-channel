//! End-to-end pass through the real routers: import an upstream playlist via
//! the admin API, curate it, personalise a customer, and check the `.m3u` and
//! the stream gateway answers a player actually gets — including the expiry
//! gate, the mid-view splice, signed variants and the device limit. Runs
//! against its own PostgreSQL schema and a stub provider.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::http::header;
use axum::routing::get;
use serde_json::{Value, json};

use crate::config::Config;
use crate::data::db::testing::TestDb;

const UPSTREAM: &str = "#EXTM3U url-tvg=\"http://provider/epg.xml\"\n\
#EXTINF:-1 tvg-id=\"s1\" tvg-logo=\"http://p/1.png\" group-title=\"Спорт\",Sport 1\nhttp://provider/1.ts\n\
#EXTINF:-1 tvg-id=\"s2\" group-title=\"Спорт\",Sport 2\nhttp://provider/2.ts\n\
#EXTINF:-1 tvg-id=\"n1\" group-title=\"Новости\",News 1\nhttp://provider/3.ts\n";

const MEDIA: &str = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:6.000,\nseg_001.ts\n#EXTINF:6.000,\nseg_002.ts\n";
const MASTER: &str = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"ru\",URI=\"audio/ru.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO=\"aud\"\nv1/index.m3u8?token=abc\n";

struct Harness {
    base: String,
    http: reqwest::Client,
    cookie: String,
    csrf: String,
    upstream: String,
    data_dir: std::path::PathBuf,
    _tmp: tempfile::TempDir,
}

struct Res {
    status: u16,
    location: Option<String>,
    text: String,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }
}

impl Harness {
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Res {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.base))
            .header(header::COOKIE, &self.cookie)
            .header("x-csrf-token", &self.csrf);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status().as_u16();
        let location = res
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        Res {
            status,
            location,
            text: res.text().await.unwrap(),
        }
    }
    async fn get(&self, path: &str) -> Res {
        self.call(reqwest::Method::GET, path, None).await
    }
    async fn post(&self, path: &str, body: Value) -> Res {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }
    async fn patch(&self, path: &str, body: Value) -> Res {
        self.call(reqwest::Method::PATCH, path, Some(body)).await
    }
    async fn delete(&self, path: &str) -> Res {
        self.call(reqwest::Method::DELETE, path, None).await
    }
    async fn playlist(&self, token: &str) -> String {
        self.get(&format!("/u/{token}/playlist.m3u")).await.text
    }
    /// A stand-in for an encoded info loop (no ffmpeg here) to cut over to.
    fn write_info_loop(&self, user_id: i64) {
        let dir = self.data_dir.join("hls").join(user_id.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("index.m3u8"),
            "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.000000,\nseg_000.ts\n#EXTINF:6.000000,\nseg_001.ts\n#EXT-X-ENDLIST\n",
        )
        .unwrap();
        for f in ["seg_000.ts", "seg_001.ts"] {
            std::fs::write(dir.join(f), "ts").unwrap();
        }
    }
}

fn extinf_count(text: &str) -> usize {
    text.lines().filter(|l| l.starts_with("#EXTINF")).count()
}

fn days_from_now(n: i64) -> String {
    jiff::Zoned::now()
        .date()
        .checked_add(jiff::Span::new().days(n))
        .unwrap()
        .to_string()
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap()
    });
    format!("http://{addr}")
}

async fn harness(db: &TestDb) -> Harness {
    let upstream = serve(
        Router::new()
            .route("/list.m3u", get(|| async { UPSTREAM }))
            .route("/master/index.m3u8", get(|| async { MASTER }))
            .fallback(get(|| async { MEDIA })),
    )
    .await;
    let tmp = tempfile::tempdir().unwrap();
    let mut config = Config::load(tmp.path().to_path_buf());
    config.admin_password = "test-password".into();
    config.session_secret = "test-secret".into();
    config.public_base_url = "https://iptv.example".into();
    config.epg.foss.enabled = false;
    // Encodes fire and forget on user edits; make them fail instantly.
    config.ffmpeg_path = "ffmpeg-absent-in-tests".into();
    config.notify.dry_run = true;
    config.ensure_dirs().unwrap();
    let data_dir = config.data_dir.clone();
    let config = Arc::new(config);
    let cookie = format!(
        "{}={}",
        crate::http::auth::COOKIE_NAME,
        crate::http::auth::session_value(&config)
    );
    let csrf = crate::http::auth::csrf_token(&config);
    let state = crate::build_state(config, db.pool.clone()).await.unwrap();
    let base = serve(crate::app(state)).await;
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    Harness {
        base,
        http,
        cookie,
        csrf,
        upstream,
        data_dir,
        _tmp: tmp,
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn catalog_playlist_gateway_and_payments_end_to_end() {
    let db = TestDb::new().await;
    let h = harness(&db).await;

    // Auth: no cookie -> 401; a forged write -> 403.
    let anon = h.http.get(format!("{}/admin/api/state", h.base)).send().await.unwrap();
    assert_eq!(anon.status().as_u16(), 401);
    let forged = h
        .http
        .post(format!("{}/admin/api/users", h.base))
        .header(header::COOKIE, &h.cookie)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(forged.status().as_u16(), 403);

    // A fresh catalog: only Информация with its two channels.
    let cat = h.get("/admin/api/catalog").await.json();
    assert_eq!(cat["categories"].as_array().unwrap().len(), 1);
    assert_eq!(cat["totals"]["channels"], 2);

    // Import.
    let src = h
        .post(
            "/admin/api/catalog/sources",
            json!({"name": "Провайдер", "url": format!("{}/list.m3u", h.upstream)}),
        )
        .await;
    assert_eq!(src.status, 201);
    let source_id = src.json()["id"].as_str().unwrap().to_owned();
    let refreshed = h
        .post(&format!("/admin/api/catalog/sources/{source_id}/refresh"), json!({}))
        .await;
    assert_eq!(refreshed.json()["stats"]["added"], 3);
    let cat = h.get("/admin/api/catalog").await.json();
    let names: Vec<&str> = cat["categories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Информация", "Спорт", "Новости"]);
    assert_eq!(cat["sources"][0]["epg_url"], "http://provider/epg.xml");
    let id_of = |n: &str| {
        cat["categories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == n)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (sport, news) = (id_of("Спорт"), id_of("Новости"));

    // A dead source is reported.
    let dead = h
        .post(
            "/admin/api/catalog/sources",
            json!({"name": "Мёртвый", "url": "http://127.0.0.1:1/none.m3u"}),
        )
        .await
        .json();
    let dead_id = dead["id"].as_str().unwrap();
    assert_eq!(
        h.post(&format!("/admin/api/catalog/sources/{dead_id}/refresh"), json!({}))
            .await
            .status,
        502
    );
    assert_eq!(
        h.delete(&format!("/admin/api/catalog/sources/{dead_id}")).await.status,
        200
    );

    // Информация is protected.
    assert_eq!(
        h.patch("/admin/api/catalog/categories/info", json!({"enabled": false}))
            .await
            .status,
        400
    );
    assert_eq!(h.delete("/admin/api/catalog/categories/info").await.status, 400);

    // A plan grants categories.
    let plan = h.get("/admin/api/state").await.json()["plans"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let p = h
        .patch(
            &format!("/admin/api/plans/{plan}"),
            json!({"category_ids": [sport, news]}),
        )
        .await
        .json();
    assert_eq!(p["features"], json!(["Спорт", "Новости"]));
    assert_eq!(
        h.patch(&format!("/admin/api/plans/{plan}"), json!({"category_ids": ["nope"]}))
            .await
            .status,
        400
    );

    // A customer gets them.
    let u = h
        .post(
            "/admin/api/users",
            json!({"username": "ivan", "plan_id": plan, "expires_at": days_from_now(60)}),
        )
        .await;
    assert_eq!(u.status, 201);
    let (uid, token) = (
        u.json()["id"].as_i64().unwrap(),
        u.json()["token"].as_str().unwrap().to_owned(),
    );
    let pl = h.playlist(&token).await;
    assert!(pl.contains("group-title=\"Спорт\",Sport 1") && pl.contains("group-title=\"Новости\",News 1"));
    assert!(pl.contains(&format!(
        "url-tvg=\"https://iptv.example/u/{token}/epg.xml,http://provider/epg.xml\""
    )));
    assert_eq!(extinf_count(&pl), 4);

    // Rename + move.
    let rows = h
        .get(&format!("/admin/api/catalog/channels?category={sport}"))
        .await
        .json();
    let sport1 = rows["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "Sport 1")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    h.patch(
        &format!("/admin/api/catalog/channels/{sport1}"),
        json!({"name": "Спорт Первый", "category_id": news}),
    )
    .await;
    let pl = h.playlist(&token).await;
    assert!(pl.contains("group-title=\"Новости\",Спорт Первый") && !pl.contains("Sport 1"));

    // Global kill switch.
    h.patch(
        &format!("/admin/api/catalog/categories/{news}"),
        json!({"enabled": false}),
    )
    .await;
    assert!(!h.playlist(&token).await.contains("group-title=\"Новости\""));
    h.patch(
        &format!("/admin/api/catalog/categories/{news}"),
        json!({"enabled": true}),
    )
    .await;

    // A personal pin affects this customer only, and is counted.
    let other = h
        .post(
            "/admin/api/users",
            json!({"username": "petr", "plan_id": plan, "expires_at": days_from_now(60)}),
        )
        .await
        .json();
    h.patch(
        &format!("/admin/api/users/{uid}/channels"),
        json!({"categories": {sport.clone(): false}}),
    )
    .await;
    assert!(!h.playlist(&token).await.contains("group-title=\"Спорт\""));
    assert!(
        h.playlist(other["token"].as_str().unwrap())
            .await
            .contains("group-title=\"Спорт\",Sport 2")
    );
    let state = h.get("/admin/api/state").await.json();
    assert_eq!(
        state["users"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == uid)
            .unwrap()["personal_overrides"],
        1
    );
    h.post(&format!("/admin/api/users/{uid}/channels/reset"), json!({}))
        .await;

    // The expiry gate, and renewal.
    h.patch(
        &format!("/admin/api/users/{uid}"),
        json!({"expires_at": days_from_now(-1)}),
    )
    .await;
    assert_eq!(extinf_count(&h.playlist(&token).await), 1);
    let view = h.get(&format!("/admin/api/users/{uid}/channels")).await.json();
    assert_eq!(
        (view["locked"].as_bool(), view["visibleCount"].as_u64()),
        (Some(true), Some(1))
    );
    h.patch(
        &format!("/admin/api/users/{uid}"),
        json!({"expires_at": days_from_now(30)}),
    )
    .await;
    assert_eq!(extinf_count(&h.playlist(&token).await), 4);
    h.patch(&format!("/admin/api/users/{uid}"), json!({"active": false}))
        .await;
    assert_eq!(extinf_count(&h.playlist(&token).await), 1);
    h.patch(&format!("/admin/api/users/{uid}"), json!({"active": true}))
        .await;

    // Bulk by filter.
    let bulk = h
        .post(
            "/admin/api/catalog/channels/bulk",
            json!({"enabled": false, "filter": {"category": sport}}),
        )
        .await;
    assert!(bulk.json()["changed"].as_u64().unwrap() >= 1);
    assert!(!h.playlist(&token).await.contains("Sport 2"));
    h.post(
        "/admin/api/catalog/channels/bulk",
        json!({"enabled": true, "filter": {"category": sport}}),
    )
    .await;

    // A re-import keeps the edits.
    h.post(&format!("/admin/api/catalog/sources/{source_id}/refresh"), json!({}))
        .await;
    assert!(
        h.playlist(&token)
            .await
            .contains("group-title=\"Новости\",Спорт Первый")
    );

    // ---- The stream gateway ----
    let hls = h
        .post(
            "/admin/api/catalog/channels",
            json!({"name": "HLS Channel", "url": format!("{}/live/1.m3u8", h.upstream), "category_id": sport}),
        )
        .await
        .json();
    let hls_id = hls["id"].as_str().unwrap().to_owned();
    assert_eq!(
        h.patch("/admin/api/gateway", json!({"enabled": true})).await.json()["enabled"],
        true
    );
    let info_stream = format!("https://iptv.example/hls/{token}/index.m3u8");
    let pl = h.playlist(&token).await;
    let re = regex::Regex::new(&format!(
        r"(?m)^https://iptv\.example(/c/{token}/[A-Za-z0-9_-]+/{hls_id}\.m3u8)$"
    ))
    .unwrap();
    let gate = re.captures(&pl).expect("tagged gate link")[1].to_owned();
    assert!(pl.lines().any(|l| l == "http://provider/2.ts"), "raw TS stays direct");

    let m = h.get(&gate).await;
    assert_eq!(m.status, 200);
    assert!(m.text.contains(&format!("{}/live/seg_001.ts", h.upstream)));
    assert!(m.text.contains(&format!("URI=\"{}/live/key.bin\"", h.upstream)));

    // Revoked mid-view: spliced onto the info card.
    h.write_info_loop(uid);
    h.patch(
        &format!("/admin/api/users/{uid}/channels"),
        json!({"channels": {hls_id.clone(): false}}),
    )
    .await;
    let cut = h.get(&gate).await;
    assert!(cut.text.contains(&format!("{}/live/seg_002.ts", h.upstream)));
    let splice = regex::Regex::new(&format!(r"#EXT-X-DISCONTINUITY\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6\.000000,\nhttps://iptv\.example/hls/{token}/seg_000\.ts\?s=\d+")).unwrap();
    assert!(splice.is_match(&cut.text), "{}", cut.text);
    let tune = h.get(&format!("/c/{token}/tune1/{hls_id}.m3u8")).await;
    assert_eq!(
        (tune.status, tune.location.as_deref()),
        (302, Some(info_stream.as_str()))
    );
    // Sticky until a fresh tune-in.
    h.post(&format!("/admin/api/users/{uid}/channels/reset"), json!({}))
        .await;
    assert!(h.get(&gate).await.text.contains("/hls/"));
    assert!(
        h.get(&format!("/c/{token}/tune2/{hls_id}.m3u8"))
            .await
            .text
            .contains(&format!("{}/live/seg_001.ts", h.upstream))
    );
    // Legacy links keep working; unknown token / channel behave.
    assert_eq!(h.get(&format!("/c/{token}/{hls_id}")).await.status, 200);
    assert_eq!(h.get(&format!("/c/unknown-token/{hls_id}.m3u8")).await.status, 404);
    assert_eq!(
        h.get(&format!("/c/{token}/gone")).await.location.as_deref(),
        Some(info_stream.as_str())
    );

    // Master playlists gate their variants with signed links.
    let master = h
        .post(
            "/admin/api/catalog/channels",
            json!({"name": "Master", "url": format!("{}/master/index.m3u8", h.upstream), "category_id": sport}),
        )
        .await
        .json();
    let master_id = master["id"].as_str().unwrap().to_owned();
    let mtext = h.get(&format!("/c/{token}/tvA/{master_id}.m3u8")).await.text;
    let links: Vec<String> = regex::Regex::new(r#"https://iptv\.example/c/[^\s"]+\.m3u8"#)
        .unwrap()
        .find_iter(&mtext)
        .map(|m| m.as_str().to_owned())
        .collect();
    assert_eq!(links.len(), 2);
    let variant = links
        .iter()
        .find(|u| !mtext.contains(&format!("URI=\"{u}\"")))
        .unwrap()
        .replace("https://iptv.example", "");
    assert!(
        h.get(&variant)
            .await
            .text
            .contains(&format!("{}/master/v1/seg_001.ts", h.upstream))
    );
    let mut parts: Vec<String> = variant.split('/').map(str::to_owned).collect();
    parts[5] = "A".repeat(parts[5].len());
    assert_eq!(h.get(&parts.join("/")).await.status, 404, "the signature binds the URL");

    // The device limit.
    let one = h
        .post(
            "/admin/api/plans",
            json!({"name": "Один экран", "price_eur": 3, "category_ids": [sport], "max_devices": 1}),
        )
        .await
        .json();
    let ou = h
        .post(
            "/admin/api/users",
            json!({"username": "one-screen", "plan_id": one["id"], "expires_at": days_from_now(30)}),
        )
        .await
        .json();
    let (oid, otok) = (ou["id"].as_i64().unwrap(), ou["token"].as_str().unwrap().to_owned());
    h.write_info_loop(oid);
    let tv = format!("/c/{otok}/tv/{hls_id}.m3u8");
    let phone = format!("/c/{otok}/phone/{hls_id}.m3u8");
    assert_eq!(h.get(&tv).await.status, 200);
    assert_eq!(h.get(&tv).await.status, 200);
    assert_eq!(
        h.get(&phone).await.location.as_deref(),
        Some("https://iptv.example/notice/devices/index.m3u8")
    );
    let devices = h.get(&format!("/admin/api/users/{oid}/devices")).await.json();
    let allowed: Vec<bool> = devices["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["allowed"].as_bool().unwrap())
        .collect();
    assert_eq!(allowed, [true, false]);
    assert_eq!(
        h.patch(&format!("/admin/api/users/{oid}"), json!({"max_devices": 2}))
            .await
            .json()["device_limit"],
        2
    );
    assert_eq!(h.get(&phone).await.status, 200);
    assert_eq!(
        h.patch(&format!("/admin/api/users/{oid}"), json!({"max_devices": null}))
            .await
            .json()["device_limit"],
        1
    );
    assert!(
        h.get(&phone)
            .await
            .text
            .contains(&format!("{}/live/seg_002.ts", h.upstream)),
        "later device cut over mid-view"
    );
    assert!(!h.get(&tv).await.text.contains("#EXT-X-DISCONTINUITY"));
    assert_eq!(
        h.patch(&format!("/admin/api/users/{oid}"), json!({"max_devices": "x"}))
            .await
            .status,
        400
    );

    // Gateway off: new playlists are direct, old links keep working.
    h.patch("/admin/api/gateway", json!({"enabled": false})).await;
    assert!(
        h.playlist(&token)
            .await
            .contains(&format!("{}/live/1.m3u8", h.upstream))
    );
    assert_eq!(h.get(&gate).await.status, 200);

    // ---- Payments ----
    h.patch(&format!("/admin/api/plans/{plan}"), json!({"billing_period": "month"}))
        .await;
    h.patch(&format!("/admin/api/users/{uid}"), json!({"expires_at": "2099-03-15"}))
        .await;
    let pay = h
        .post(&format!("/admin/api/users/{uid}/payment"), json!({}))
        .await
        .json();
    assert_eq!(
        (pay["period"].as_str(), pay["user"]["expires_at"].as_str()),
        (Some("month"), Some("2099-04-15"))
    );
    let three = h
        .post(&format!("/admin/api/users/{uid}/payment"), json!({"count": 3}))
        .await
        .json();
    assert_eq!(three["user"]["expires_at"], "2099-07-15");
    assert_eq!(
        h.post(&format!("/admin/api/users/{uid}/payment"), json!({"count": 0}))
            .await
            .status,
        400
    );
    assert_eq!(h.post("/admin/api/users/999999/payment", json!({})).await.status, 404);
    let ledger = h.get("/admin/api/payments").await.json();
    let mine: Vec<&Value> = ledger["payments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["user_id"] == uid)
        .collect();
    assert_eq!(mine.len(), 2);
    let price = h.get("/admin/api/state").await.json()["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == plan)
        .unwrap()["price_cents"]
        .as_i64()
        .unwrap();
    assert_eq!(mine[0]["amount_cents"].as_i64(), Some(price * 3));
    // Only the latest can be undone.
    let older = mine[1]["id"].as_str().unwrap();
    assert_eq!(h.delete(&format!("/admin/api/payments/{older}")).await.status, 409);
    let newest = mine[0]["id"].as_str().unwrap();
    let undone = h.delete(&format!("/admin/api/payments/{newest}")).await.json();
    assert_eq!(undone["user"]["expires_at"], "2099-04-15");

    // Deleting a category drops it from plans.
    let temp = h
        .post("/admin/api/catalog/categories", json!({"name": "Временная"}))
        .await
        .json();
    let temp_id = temp["id"].as_str().unwrap().to_owned();
    h.patch(
        &format!("/admin/api/plans/{plan}"),
        json!({"category_ids": [sport, news, temp_id]}),
    )
    .await;
    h.delete(&format!("/admin/api/catalog/categories/{temp_id}")).await;
    let ids = h.get("/admin/api/state").await.json()["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == plan)
        .unwrap()["category_ids"]
        .clone();
    assert_eq!(ids, json!([sport, news]));

    db.drop().await;
}
