# Repository guidance

## Product and language

This is a multi-customer IPTV subscription server. Provider playlists and curated channel packages are the primary product. The personal information channel and shared media channel are built-in channels. Preserve Russian strings in the admin and channel graphics.

## Stack and layout

The backend is Rust (edition 2024), axum and tokio. The crate lives at the repository root. Put backend code under the existing concern directories in `src/`: `core`, `data`, `playlist`, `http`, `render`, `encode`, `media`, `epg`, `news`, `notify`. `src/main.rs` wires startup, commands and routes; `src/config.rs` reads the environment and `.env`.

The admin is React + Vite + Ant Design in `frontend/`, with its own package manifest and lockfile. `npm run build --prefix frontend` produces `public/admin`; Rust serves the SPA at `/admin` and assets at `/admin/static/`. Keep the admin API response contracts compatible with `frontend/src/lib/api.js` and the page components.

PostgreSQL stores metadata. `migrations/` is embedded with sqlx and migrated on startup. `DATA_DIR` holds generated HLS, uploaded media and cached clips. `APP_ROOT`, or the working directory, resolves `.env` and relative paths. `DATABASE_URL` supports the same environment-over-file precedence as other settings.

## Commands

```bash
cargo run --locked                      # server
cargo run --locked -- seed              # demo users if none exist
cargo run --locked -- import-json data  # legacy JSON -> PostgreSQL, one transaction
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
TEST_DATABASE_URL=postgres://iptv:iptv@localhost:55432/iptv cargo test --locked
npm ci --prefix frontend
npm run build --prefix frontend
docker compose up -d --build m3u-info
DATABASE_URL=postgres://iptv:iptv@test-db:5432/iptv docker compose --profile test run --build --rm test
```

Tests need a dedicated PostgreSQL database and create a unique schema per test. Unit tests live with their modules; `src/http/route_tests.rs` runs the full router against a stub provider and real PostgreSQL. Exact ffmpeg argument snapshots live in `tests/fixtures/`. Keep these snapshots stable unless an intended encode change requires an update. Run actual ffmpeg and browser checks when changing those runtime paths; argument snapshots alone do not establish playback or UI compatibility.

Unsafe Rust is forbidden. Clippy pedantic runs with project-specific documented exceptions in `Cargo.toml`. Avoid adding blanket lint suppression.

## Invariants

- Commit every database mutation before replacing the in-memory snapshot. Failed writes must leave reads unchanged. Keep multi-record operations transactional.
- Run a single application instance per database: reads are cached in process and are not refreshed from other writers.
- Preserve customer ids, stream tokens, notification tokens, ordering, media references and extra fields during JSON import. `--force` is an explicit replacement operation, not the normal import path.
- Administrator channel/category edits beat upstream refreshes. Vanished channels are marked missing, not deleted. Imported rows use enable/disable; only custom rows can be deleted.
- Category access is resolved by customer pin, global enable, then plan membership. Empty plan categories grant no imported channels. Keep playlist and gateway entitlement decisions identical.
- Only HLS provider channels are published through the gateway. Android players require `.m3u8` URLs and same-origin manifest serving; avoid cross-protocol redirects. Signed variants must continue checking entitlement.
- Mid-view revocation splices a discontinuity and the personal info loop into a monotonic live window. Preserve sequence/discontinuity invariants across loop wraps.
- Keep notification tokens separate from stream capability tokens. Customer URLs are credentials; avoid exposing them in logs and use HTTPS off-LAN.
- Admin sessions use HMAC, HttpOnly/SameSite cookies, and login rate limiting. Mutations require the CSRF header learned from `/admin/api/state`. Preserve per-IP/per-token sign-up limits and email double opt-in.
- Bound upstream HTTP fetches by protocol, timeout and byte limit. Keep proxy trust explicit.
- Article layout and rendering use the same text shaper/font database. Preserve private sections and per-viewer variants, one-at-a-time video normalization, debounced loop rebuilds and cached clips.
- Uploaded videos are normalized once; delete original uploads only after successful processing. Store asset metadata in PostgreSQL and files under the persistent data volume.
- Email dispatch uses HTTPS provider APIs. `NOTIFY_DRY_RUN=true` is the local test setting.

## Deployment

The Docker runtime contains the Rust binary, ffmpeg and Inter; Node and cargo stay in build/test stages. It runs as uid 1000. Compose connects to an existing `shared-db` network and requires an `iptv` PostgreSQL role/database. Back up both PostgreSQL and the data volume.

Before a production cutover, build and validate the runtime image, save the old stack/image and data, stop legacy writes, import the final JSON in one transaction, and verify existing customer URLs after switching. Keep a rollback image and configuration. PostgreSQL edits do not flow back to legacy JSON. See README.md and docs/rust-migration-validation.md for the commands and current validation evidence.
