# Rust migration validation

Validation performed on 2026-10-13.

## Build and regression checks

- `cargo test --locked` with a temporary PostgreSQL 17 database: **157 passed, 0 failed**. The two ignored tests generate manual preview images.
- `cargo fmt --check`: passed.
- `cargo clippy --locked --all-targets -- -D warnings`: passed.
- `npm run build --prefix frontend`: passed; Vite writes the SPA and assets into `public/admin`.
- `docker build -t iptv-server:rust-validation .`: passed. Rust 1.99 builds the backend; Node 22 builds the frontend. Debian Bookworm runtime includes ffmpeg 5.1.9 and Inter, runs as uid 1000, and passes its healthcheck.
- Compose configuration validates with `DATABASE_URL` set. The application joins the external `shared-db` network; the optional test service uses a separate temporary PostgreSQL service.

The database tests include failed-write cache preservation and a real router pass covering catalog import, entitlement, signed HLS variants, revocation/splicing, devices and payments. Both ffmpeg argument snapshots match the inherited Node snapshots.

## Browser and real ffmpeg

Headless Chrome through Playwright used the actual built SPA and runtime image, with an isolated database and data volume.

- Logged in and opened all nine navigation sections: overview, playlist, clients, payments, devices, plans, information channel, media and notifications. No JavaScript exceptions or failed API requests occurred during the successful checks. The initial unauthenticated state request returns the expected 401.
- Created a customer through the form and confirmed persistence after reloading the page.
- Created and saved an article containing Russian text, an uploaded image and an uploaded video. Reopening the article preserved the text and both asset references.
- The image upload was stored successfully. A generated two-second H.264/AAC test video was normalized to the configured 640×360 validation resolution; the normalized asset became ready with an audio track and a poster.
- Real ffmpeg encoded the article into a **24-second H.264/AAC clip** and a segmented media loop. `ffprobe` confirmed 640×360 video at 12 fps, and ffmpeg decoded six seconds of the HLS loop without errors.
- The server-rendered article preview and an extracted encoded frame were inspected visually. Russian text, image sizing and the channel title rendered correctly.
- Both `/hls/:token/index.m3u8` and `/m/:token/index.m3u8` returned live playlists with eight segments and no `EXT-X-ENDLIST`. Segment requests with `Range: bytes=0-187` returned **206** and 188 bytes.
- XMLTV returned **200** with a `<tv>` document, and logout returned the browser to the login screen.

Temporary validation artifacts and scripts are under `/tmp/iptv-rust-validation/artifacts` and `/tmp/iptv-browser-check` on the validation machine; these paths are session artifacts, not required runtime files.

## Legacy import rehearsal

A read-only copy of the production JSON stores was imported into a separate temporary database with the built runtime image. The report contained no skipped records:

| Record | Imported |
| --- | ---: |
| Plans | 3 |
| Customers | 3 |
| Email subscribers | 3 |
| Payments | 0 |
| Incidents | 1 |
| Newsletters | 1 |
| Sources | 1 |
| Categories | 10 |
| Channels | 702 |
| Overrides | 0 |
| Media articles | 2 |
| Media assets | 5 |

The production PostgreSQL server is version 18.6; the final cutover separately verifies the migrated records and the live routes there.

## Production cutover

The stack on `root@37.27.45.214` now uses `iptv-server:rust-20261013` and keeps the original port, environment settings and `/data/compose/12/data` bind mount. Its existing network remains attached, with `shared-db` added for PostgreSQL. The Portainer stack file at `/var/lib/docker/volumes/portainer_data/_data/compose/12/docker-compose.yml` now references the staged image.

An `iptv` login and database owned by that login were created in `shared-postgres`. The final import ran with the Node application stopped and preserved 3 customers, 3 plans, 702 channels, 2 media articles and 5 assets. All customer ids and stream tokens matched the pre-cutover state, and the customer playlist channel counts matched their baselines.

Live validation returned 200 for catalog, channels, payments, devices, notifications, newsletters and media reads. All three customers' playlists and XMLTV guides returned 200. Each customer's information and media HLS manifests had eight live segments, and segment byte-range requests returned 206.

The first attempt automatically rolled back because the validation script requested a write-only catalog endpoint with GET. The checker was corrected to use `/admin/api/catalog` and verified locally before retrying. The successful retry backed up the earlier PostgreSQL import and re-imported a fresh stopped-Node snapshot.

Rollback material is preserved at `/opt/backups/iptv-rust-cutover-20261013T202907Z`: the full data archive, previous Compose/environment/container configuration, pre-retry and post-import PostgreSQL dumps, the Node rollback image reference, and structured import/verification reports. The matching rollback image is `iptv-server:node-rollback-20261013T202907Z`. The staged Rust image, source and cutover script are under `/opt/iptv-rust-20261013`.

Rolling back after new admin edits requires a deliberate data reconciliation: the legacy JSON snapshot does not include edits made to PostgreSQL after cutover.

The live HTTPS admin at `https://estoniatv.team/admin` was also checked in Chrome: all nine sections opened, login and logout worked, and there were no JavaScript exceptions or failed application API requests. The runtime is healthy, runs `iptv-server` as uid 1000, and the `iptv` database role has no superuser, role-creation or database-creation privileges. The catalog contains 702 imported rows; the admin reports 701 present channels because one imported row is marked missing.

Startup then regenerated all three personal information channels and rebuilt the public media loop plus three private variants. The completed media build reported two public articles and a 108-second public loop, with no article/build errors. The rebuilt production HLS loop decoded six seconds successfully. The private article content took about eleven minutes to encode at the existing production settings; cached loops served viewers throughout that rebuild.

A later live check observed intermittent provider-fetch timeouts. Curl and the rollback Node image returned valid provider manifests, and a temporary diagnostic using the exact Rust HTTP dependencies initially reproduced a timeout. Subsequent default, IPv4, HTTP/1 and proxy-disabled Rust requests all returned 200. The live gateway also returned 200 without a redirect, and no new fetch errors appeared in the following three-minute observation window. No transport setting was changed: these checks did not isolate a configuration-specific cause.
