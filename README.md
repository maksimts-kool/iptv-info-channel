# IPTV Info Channel

A Rust IPTV subscription server with a React admin panel. Import provider M3U playlists, curate channels and categories, assign channel packages to customers, and issue private playlists. Each customer also receives a personal information channel and a shared media channel.

The backend uses axum and tokio. PostgreSQL stores customers, plans, settings, the catalog, payments, email subscriptions, newsletters, media articles and asset metadata. Reads use an in-memory snapshot; writes commit to PostgreSQL before publishing the new snapshot. Schema migrations are embedded in the binary and applied at startup.

## Features

- Provider playlist imports and scheduled refreshes; administrator edits and missing-channel markers survive refreshes.
- Per-plan categories and per-customer category/channel overrides.
- Optional HLS gateway with signed variant URLs, checks on every manifest refresh, mid-view splicing into the information channel, and simultaneous-device limits.
- Personal HLS information channels with account details, expiry status, branding, incidents, provider notices, music and QR codes.
- One encode queue for the information channels: repeat requests merge, a waiting player goes first, `ENCODE_WORKERS` caps parallel ffmpeg runs, and failures retry once. The admin follows it, and the media channel's builds, live in a job panel with cancel, retry and clear.
- XMLTV and OTT-play FOSS programme guides.
- Provider news polling and optional AI summaries through OpenRouter.
- Email double opt-in, expiry/status notifications, and audience-targeted newsletters through Brevo or Resend.
- Media articles with formatted text, images, videos, tables, private sections, per-customer variants and a live HLS loop.
- A Russian-language admin panel for catalog, clients, payments, devices, viewing statistics, plans, information channel, media and notifications.

Customer URLs contain access tokens. Use HTTPS when exposing the service outside your LAN, and keep playlist URLs private. The notification QR uses a separate token and does not grant stream access.

## Docker

The production image builds React and Rust in separate stages. The runtime contains the Rust binary, ffmpeg, Inter fonts, CA certificates and tini; it runs as uid 1000.

The Compose service connects to an existing PostgreSQL container named `shared-postgres` on the external `shared-db` network. Create the `iptv` login and an `iptv` database owned by it before starting the application. For example, in an administrator `psql` session:

```sql
CREATE ROLE iptv LOGIN;
\password iptv
CREATE DATABASE iptv OWNER iptv;
```

```bash
cp .env.example .env
# Set DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET and PUBLIC_BASE_URL.
# DATABASE_URL=postgres://iptv:<url-encoded-password>@shared-postgres:5432/iptv
# PUBLIC_BASE_URL must be the origin your players can reach.
docker compose up -d --build m3u-info
docker compose logs -f m3u-info
```

Open `/admin` on that origin and log in with `ADMIN_PASSWORD`. Set up sources, categories, plans and customers in the panel. Optional demo data:

```bash
docker compose exec m3u-info iptv-server seed
```

The bind-mounted `./data` directory must be writable by uid 1000. PostgreSQL holds metadata; `data/` holds media uploads, article clips, previews and HLS output. Back up both PostgreSQL and this directory.

For a Portainer Git stack, select `refs/heads/rust-port` and `docker-compose.yml`, copy the production environment settings, and set `DATA_VOLUME` to the absolute host path of the existing data directory. This keeps media files independent of Portainer's Git checkout directory. Set `DATABASE_URL` to the existing `iptv` database on `shared-db`. Keep Git polling and automatic updates disabled, and deploy new commits manually in Portainer. Stop the previous stack before deploying the replacement: only one server instance may use this database and port.

The production Portainer stack is `iptv-rust`. It tracks `refs/heads/rust-port`; GitOps source polling and automatic stack updates are disabled. Deploy new commits manually in Portainer. The previous `iptvinfov2` stack is stopped and retained for rollback.

## Migrate from the Node backend

Keep the old image, Compose configuration and a complete data backup for rollback. Stop the old application before taking the final JSON snapshot so no edits race the import. Use the same data volume for the Rust service: uploaded media and cached HLS files are not stored in PostgreSQL.

```bash
# Build the new image before stopping the running application.
docker compose build m3u-info
docker compose stop m3u-info
# Back up ./data and the old stack configuration here.
docker compose run --rm --no-deps m3u-info import-json /app/data
docker compose up -d --no-build m3u-info
```

`iptv-server import-json [DIR] [--force]` imports `db.json` and `catalog.json`, including the old `media_channel` articles and assets, in one transaction. It preserves customer ids and tokens, resets database sequences, validates dates, and reports skipped records. It refuses a populated destination unless `--force` is supplied. `--force` replaces destination records; use it only for a deliberate re-import. The importer leaves the JSON files and media files in place.

Check `/healthz`, admin login and the imported counts, an existing customer playlist and EPG, info-channel playback, and media-channel playback before removing the rollback image. To roll back, stop the Rust service and restore the old image/configuration with the backed-up JSON and data. Edits made after cutover live in PostgreSQL and are not written back to the legacy JSON files.

## Local development

Use Rust 1.99+, Node 22+ for the frontend, PostgreSQL, ffmpeg/ffprobe and Inter fonts. The backend needs no Node packages.

```bash
npm ci --prefix frontend
npm run build --prefix frontend
# .env is loaded from the working directory, or APP_ROOT if set.
# For a locally published database, use localhost and its published port.
cargo run --locked -- seed
cargo run --locked
```

The frontend build writes to `public/admin`. For hot reload, run the backend on port 9222 and `npm run dev --prefix frontend`; Vite proxies admin API and authentication requests to it.

Settings are documented in [.env.example](.env.example). Process environment variables override `.env`. Relative data/music paths resolve against `APP_ROOT`, or the working directory. `DATABASE_URL` is required. Admin toggles for notifications and the gateway override their environment defaults. Optional `RUST_LOG` controls tracing.

## Checks

Database tests create and drop unique schemas inside a dedicated test database. Never point `TEST_DATABASE_URL` at production.

```bash
# Default: postgres://iptv:iptv@127.0.0.1:55432/iptv
TEST_DATABASE_URL=postgres://iptv:iptv@localhost:55432/iptv cargo test --locked
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
npm run build --prefix frontend
```

Or use the optional Docker test image and temporary PostgreSQL service:

```bash
# Compose also requires DATABASE_URL to parse the application service.
DATABASE_URL=postgres://iptv:iptv@test-db:5432/iptv docker compose --profile test run --build --rm test
# Remove the temporary test database once finished.
docker compose --profile test stop test-db
docker compose --profile test rm -f test-db
```

The Rust suite includes database/import tests, a route integration test with a stub provider, HLS entitlement/splice/device checks, text layout tests, and exact ffmpeg argument snapshots inherited from the Node backend. Real ffmpeg and browser checks are documented in [docs/rust-migration-validation.md](docs/rust-migration-validation.md).

## Customer endpoints

| Endpoint | Purpose |
| --- | --- |
| `/u/:token/playlist.m3u` | Personal channel playlist |
| `/hls/:token/index.m3u8` | Personal information-channel HLS |
| `/u/:token/epg.xml` | Personal XMLTV guide |
| `/m/:token/index.m3u8` | Media channel selected for the customer |
| `/c/:token/:channel.m3u8` | Optional HLS entitlement gateway |
| `/foss-epg/u/:token/channels.json` | OTT-play FOSS channel map (programme files under `epg/`) |
| `/sub/:notify_token` | Email sign-up with a separate notification token |
| `/admin` | React admin panel |
| `/admin/api/...` | Authenticated admin API |
| `/healthz` | Liveness endpoint |

## Layout

```text
src/main.rs          CLI, router, startup and background tasks
src/config.rs        Typed configuration and .env loading
src/core/            Shared formatting, audience and bounded fetch helpers
src/data/            PostgreSQL store, models and transactional JSON import
src/playlist/        M3U catalog, entitlement resolution, HLS and device tracking
src/http/            Admin, catalog, media, customer, gateway and sign-up routes
src/render/          SVG/PNG rendering and shaped media-article layout
src/encode/          ffmpeg arguments, information channel, encode queue and live HLS windows
src/media/           Article documents, audience variants, assets and loop builds
src/epg/             XMLTV and OTT-play guides
src/news/            Provider news and AI summaries
src/notify/          Email templates and dispatch
migrations/          Embedded PostgreSQL schema migrations
tests/fixtures/      ffmpeg argument snapshots
frontend/            React + Vite + Ant Design admin application
public/admin/        Generated frontend build (not committed)
assets/music/        Background audio
```
