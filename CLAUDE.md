# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-user IPTV "info channel" server. Each customer gets a private looping
**HLS video channel** that displays their account status (plan, price, expiry,
days left, colour-coded status) over background music, delivered via a per-user
`.m3u` playlist that plays in any IPTV player / VLC. Ships with a
password-protected web admin (`/admin`) and a Docker image (Node + ffmpeg).

UI strings on the rendered cards and status labels are **Russian** (see
`STATUS_META` in [src/util.js](src/util.js) and the SVG text in
[src/render/overlay.js](src/render/overlay.js)). Keep that language when editing visuals.

## Layout

Source is grouped by concern, all folders exactly one level under `src/`:

```
src/
  server.js            # express wiring, landing, health, shutdown
  config.js            # .env parser + typed config (ROOT lives here — do not move)
  logger.js            # structured logger
  util.js              # formatters (dateFormatter), STATUS_META, xmlEscape
  data.js              # JSON-file store (+ seedDemo)
  seed.js              # `npm run seed` CLI shim -> data.seedDemo()
  notify.js            # email notifications (transport, templates, dispatch)
  render/  overlay.js status.js worldcup.js       # SVG frames + their data models
  encode/  channel.js liveloop.js                 # ffmpeg encode + live HLS window
  http/    stream.js subscribe.js admin.js auth.js # all HTTP surfaces
  epg/     epg.js epgfoss.js xxhash32.js          # XMLTV + OTT-play FOSS guides
  public/admin/        # built admin UI (Vite output from ../frontend; served by http/admin.js)

frontend/              # React + Vite + Ant Design admin app (own package.json)
```

## Commands

Docker is the documented path (it provides ffmpeg + the Inter font):

```bash
docker compose up -d --build                  # build + run the container
docker compose logs -f m3u-info               # follow runtime logs
docker compose exec m3u-info npm run seed      # create demo users (no-op if any exist)
docker compose --profile test run --rm test    # run the whole test suite in-image
```

Running on the host still works (needs Node 20+ and **ffmpeg on PATH**, override
with `FFMPEG_PATH`), but is no longer the documented path:

```bash
npm start                       # run server (src/server.js)
npm run dev                     # run with --watch
npm run seed                    # create demo users
npm test                        # node --test (built-in runner)
node --test test/util.test.js   # a single test file
```

No build step, no linter, no TypeScript on the backend. Pure ESM
(`"type": "module"`), Node 20+. Tests use the built-in `node:test` runner and
cover the pure-logic modules (`util`, `encode/liveloop`, `epg/epg`,
`epg/epgfoss`, `render/status`, `epg/xxhash32`, `render/worldcup`, and the
`.m3u`-playlist builders and admin-domain pure fns now living in `http/`) plus
route/integration tests for the FOSS endpoints. The frontend has no backend
tests (it is a client rewrite against the unchanged `/admin/api`). The
ffmpeg encode has no live render test, but
[test/channel-args.test.js](test/channel-args.test.js) pins the exact ffmpeg
argv against a golden snapshot so the arg builders can be refactored safely (the
rationale + how to regenerate the golden live in a comment atop the builders in
[src/encode/channel.js](src/encode/channel.js)). The `.dockerignore` deliberately
ships `test/` into the image so the suite runs in the `test` compose service.

## Architecture

Request/data flow, entry point [src/server.js](src/server.js):

1. **Data** — [src/data.js](src/data.js) is a JSON-file store, **not** a real
   database (the project predates this and some history/comments still say
   "SQLite"). State lives in `DATA_DIR/db.json` (`plans`, `users`, `incidents`,
   `settings`) with atomic writes (tmp + rename) and a corrupt-file
   backup-and-reset path. Users
   are decorated with their plan's fields on read (mimics an old SQL join).
   Access tokens are unguessable nanoid strings; there is no user login, only
   the per-user URL token and the single admin password. `seedDemo()` (the
   `npm run seed` helper) also lives here.

2. **Render** — [src/render/overlay.js](src/render/overlay.js) builds the channel frames as
   **SVG** and rasterizes to PNG with `sharp`. Frames: a brand intro slide; a
   "body" that is the account card (`buildCardSvg`) or, for expired accounts, an
   auto-layout plans grid (`buildExpiredPlansSvg`); and (when
   `STATUS_SLIDE_ENABLED`) a global Better Stack–style status board
   (`buildStatusSlideSvg`, fed by `statusSummary()` in
   [src/render/status.js](src/render/status.js)); and (when the World Cup slide is enabled — via
   `WORLDCUP_SLIDE_ENABLED` or the admin toggle, see Admin below) a global
   auto-updating World Cup 2026 **match-list** slide (`buildWorldCupSlideSvg`, fed
   by `getWorldCupSummary()` in [src/render/worldcup.js](src/render/worldcup.js) — the knockout
   stage only (1/16 final onward, **no group games**): a static seeding skeleton
   merged with live results from a free football API, windowed to an adaptive ~6
   matches around "today" by `buildWorldCupModel`. Before the knockout starts it
   shows a "playoffs start on <date>" message; once the Final is decided, a
   champion summary. Cached so a bulk regen calls the API at most once.
   `getWorldCupSummary()` is the enabled-gated encode feed; `getWorldCupModel()`
   builds the same model unconditionally for the admin preview). In the final days before expiry the card
   swaps its lower half for a compact "продлите подписку" plan strip
   (`buildRenewingCardSvg`); healthy cards are unchanged. On the **final valid
   day** (and once expired) the body becomes the full plans grid instead — same
   `buildExpiredPlansSvg`, with a `variant: 'lastDay'` orange "ПОСЛЕДНИЙ ДЕНЬ"
   header vs. the red "ПОДПИСКА ИСТЕКЛА" one. `buildBodySvg` owns this routing.
   All SVGs use a fixed 1280×720 viewBox scaled to the configured output
   resolution.

3. **Encode** — [src/encode/channel.js](src/encode/channel.js) spawns **ffmpeg** to turn the
   PNG(s) + looped music into HLS segments. Two paths: an intro path
   (slide → `xfade` transition → card, low fps) and a plain still-card path
   (intro disabled, very low fps). Each enabled global slide (status board, then
   World Cup match list) is appended as **another frame** — the intro path chains
   more `xfade`s, the still path adds more `concat` inputs (`introWithExtrasArgs`
   / `stillFfmpegArgs` take an ordered `extras` list). Each slide holds for its
   own configured duration — the account card for `ACCOUNT_SLIDE_SECONDS`, just like
   the intro/status/World Cup slides set their own — and the loop total is their
   sum, rounded to a whole number of `hlsTime` segments (`tileToSegments`)
   so the looped VOD tiles cleanly with no runt segment; the still card absorbs
   the sub-segment rounding slack. **The exported arg builders
   (`introFfmpegArgs`/`stillFfmpegArgs`) are pinned by a byte-identity snapshot
   ([test/channel-args.test.js](test/channel-args.test.js)); a comment atop them
   explains the rule and how to regenerate — never rewrite the snapshot silently.**
   A bottom-right "Далее через N" countdown to the next
   slide change is baked in via `drawtext` (`slideTimerFilters`, toggle
   `SLIDE_TIMER_ENABLED`); it needs a font ffmpeg can resolve — fontconfig
   `Inter` by default (the image installs `fonts-inter`), or `TIMER_FONT_FILE`
   (the drawtext colon-escaping gotcha is documented inline). Key
   behaviors to preserve:
   - **Content-hash skip**: `streamSignature()` hashes the SVG content + encode
     params + music mtime; an unchanged stream is *not* re-encoded. Pass
     `{ force: true }` to override.
   - **In-flight abort**: a newer `generateForUser` for the same user aborts the
     running ffmpeg via `AbortController` so the latest data wins.
   - **Atomic swap**: builds into a temp dir on the *same* filesystem as the
     target (cross-device `rename` throws `EXDEV` with a mounted `data/`
     volume), then `rmSync` + `renameSync` over the live dir.
   - **Daily cron** at 00:05 (`startDailyRefresh`) rebuilds every stream so the
     "days left" counter and expiry status stay current.

4. **Serve as live** — [src/encode/liveloop.js](src/encode/liveloop.js) presents the
   pre-generated finite VOD asset as an **endless live HLS channel**: a sliding
   window over the looped segments with monotonically increasing media/
   discontinuity sequence numbers (they must never move backwards across a
   regeneration — see `previousPosition` handling in encode/channel.js). All viewers
   share one live timeline: tuning in joins the stream wherever it currently is,
   it never restarts at the intro on channel open. (The brand intro slide, when
   `INTRO_ENABLED`, is just ordinary loop content baked in by channel.js — it
   only shows when the shared loop cycles past it.) **HLS player compatibility is
   fragile here** — the ≥8-segment window, runt-segment drop, `#EXT-X-VERSION:6`
   and `Range` support are all load-bearing and documented in a caution atop the
   file; don't "simplify" the playlist construction without strict-player testing.

5. **Public endpoints** — [src/http/stream.js](src/http/stream.js) (which merges the
   former `routes/stream.js`, `playlist.js` and `routes/foss-epg.js`):
   `/u/:token/playlist.m3u` (and `/playlist.m3u?token=`) return the `.m3u`;
   `/hls/:token/:file` lazily generates (on first request) and serves the
   `index.m3u8` live playlist + `.ts` segments. Segment requests honor HTTP
   `Range` (strict players probe with `Range:` and stall on a plain 200).
   `/u/:token/epg.xml` (and `/epg.xml?token=`) return the **XMLTV programme
   guide** (see EPG below); the `.m3u` header advertises it via `url-tvg` and the
   `#EXTINF` uses a per-user `tvg-id` (`account-<token>`) matching the EPG
   `<channel id>`. The `.m3u` text itself is built by the exported
   `buildUserPlaylist`. When `EPG_FOSS_ENABLED`, the same module's
   `createFossEpgRouter`/`fossEpgRouter` additionally serves the
   OTT-play FOSS endpoints — `/foss-epg/u/:token/{channels.json,epg/<hash>.json,
   logo.svg}` plus the `/m3u/match-channels` and `/m3u/match-logos` match
   protocol (see FOSS below).

6. **EPG** — [src/epg/epg.js](src/epg/epg.js) (`buildEpgXml`) synthesises a per-user
   XMLTV guide. There's no real schedule (the channel is a looping card), so it
   emits **one `<programme>` per calendar day** over a window
   (`EPG_DAYS_BEHIND`..`EPG_DAYS_AHEAD` around "today"). Each day's `<title>` is
   the service-status headline for that day (✓ operational / ⚠ degraded / ✕
   outage), derived from incidents via `severityForDay`; `<sub-title>`/`<desc>`
   carry that user's subscription status "as of" the day (sampled at local noon
   so it decrements across the guide) plus 90-day uptime and any incident
   details. Pure logic, unit-tested ([test/epg.test.js](test/epg.test.js)) and
   built **live on request** (not pre-encoded) so days-left/status stay fresh
   without regeneration. Timestamps are local-midnight XMLTV
   (`YYYYMMDDHHMMSS +ZZZZ`) with a DST-correct offset; interpolated text is
   XML-escaped. Toggle with `EPG_ENABLED` (disabling also drops `url-tvg`).

   The per-day records are produced once by `eachEpgDay` (semantic data — each
   renderer formats its own timestamps) and consumed by both `buildEpgXml` and
   the OTT-play **FOSS JSON** guide.

7. **FOSS EPG (OTT-play)** — [src/epg/epgfoss.js](src/epg/epgfoss.js) renders a
   token-scoped JSON guide that OTT-play FOSS fetches **directly**
   (`channels.json` + `epg/<xxhash32(tvg-id)>.json`), bypassing the central
   matcher. [src/epg/xxhash32.js](src/epg/xxhash32.js) reproduces OTT-play's Go
   `OneOfOne/xxhash` so the per-channel id hashes match byte-for-byte (pinned by
   vector tests — don't swap it for a generic hash lib). The route (in
   `http/stream.js`) also proxies/merges the upstream OTT-play `match-channels`
   response so this server works as a drop-in `!epg-server` in a combined
   playlist. Pure logic is unit-tested; toggle with `EPG_FOSS_ENABLED`
   (`EPG_FOSS_PROVIDER_ID`, `EPG_FOSS_UPSTREAM_MATCH_URL`). See the README for the
   `.m3u` attributes and the **leading-`=`** requirement on `foss-tvg`/`tvg-source`.

8. **Email notifications** — [src/notify.js](src/notify.js) is the whole feature
   in one module: transport, templates, dispatch and validation. The intro slide
   carries a per-user QR (`qrPanelSvg` in render/overlay.js) to
   `/sub/:token` ([src/http/subscribe.js](src/http/subscribe.js)), where a
   customer subscribes one email with opt-in topics. That token is a **separate
   `notify_token`** (not the stream token), so photographing the on-screen QR
   can't grant stream access. Subscriptions are **double opt-in**: a new/changed
   address is stored `verified:false` with a single-use `verify_token`, gets a
   verification link (`/sub/verify/:vtoken`), and receives **no** real
   notifications until the recipient clicks it — so the flow can't be used to
   mail an unconsenting address. `expiryDue`/dispatch all gate on `verified`. Mail is sent over a
   **third-party HTTP email API** (Brevo default, Resend optional — `NOTIFY_*`
   env) because DigitalOcean blocks outbound SMTP ports; `NOTIFY_DRY_RUN` logs
   instead of sending. Three triggers: **server status** (admin incident
   raised/resolved, opt-in), **expiring soon** (`expirySweep()` from the daily
   cron, opt-in, once per expiry date via a `last_expiry_notice` dedup marker),
   and **renewal** (admin pushes expiry later — mandatory). Data lives in `data.js`
   (`Subscribers`, one per `user_id`; `NotifyLog` capped ring buffer); the global
   on/off flag is a `Settings` value (`notify_enabled`) overlaid onto
   `config.notify.enabled` by `syncNotifySettings()` (mirrors the World Cup
   pattern). The `/sub` write endpoints are rate-limited (per-IP + per-token) so
   the confirmation email can't be used as a spam relay. Pure logic is
   unit-tested ([test/notify.test.js](test/notify.test.js)); the admin card lives
   in `src/public/admin/`.

9. **Admin** — [src/http/admin.js](src/http/admin.js) is a cookie-auth JSON
   API under `/admin/api` plus static UI in `src/public/admin/`. Auth
   ([src/http/auth.js](src/http/auth.js)) is an HMAC of the admin
   password stored in the cookie, so changing `ADMIN_PASSWORD` invalidates all
   sessions; `/admin/login` is rate-limited per IP to blunt brute-force. The
   route is HTTP-only orchestration; request validation and
   response view-models are pure functions in the **same file** (formerly
   `admin-domain.js`), kept exported and side-effect-free so
   [test/admin-domain.test.js](test/admin-domain.test.js) still imports them
   directly. Most mutations
   trigger **fire-and-forget** regeneration; note that plan, branding and
   **incident** edits regenerate **all** users (expired users render every
   available plan; the status slide is global), while user edits regenerate just
   that user. Incidents (`/admin/api/incidents`, states `degraded`/`outage`)
   drive the status board's 90-day uptime strip. A **World Cup** card
   (`/admin/api/worldcup`) shows a live preview of the global bracket slide
   (`getWorldCupModel` — built even while the slide is off so it can be
   previewed) and lets the admin toggle the slide on/off and set its on-screen
   seconds. Those two flags are stored in `Settings` (`worldcup_enabled` /
   `worldcup_seconds`) and overlaid onto `config.worldcupSlide` by
   `syncWorldcupSettings()` (called at startup and after each edit), with the
   `WORLDCUP_SLIDE_ENABLED`/`WORLDCUP_SLIDE_SECONDS` env vars as the fallback
   when unset — the encode path keeps reading `config.worldcupSlide.*`, so the
   ffmpeg golden test is unaffected. The browser UI is a **React + Vite + Ant
   Design** app in [frontend/](frontend/) (its own `package.json`) that builds to
   `src/public/admin/` at Docker build time (Vite `base: '/admin/static/'`); the
   route serves that SPA shell at `/admin` with **no server-side auth gate** (the
   app renders its own login view on a 401 — there is no `login.html`/
   `requireAuthPage`). Mutating `/admin/api` calls must carry an `X-CSRF-Token`
   header (`requireCsrf`); the token is handed to the client in `/api/state`. On a
   bare host checkout with no build, `/admin` shows an "Admin UI not built" stub —
   run the Docker image, or `npm run dev` in `frontend/` (its dev server proxies
   `/admin/api` to the backend). Most mutating actions in the app run through a
   shared `withRegen` banner/reload lifecycle (frontend `App.jsx` + `RegenBanner`).

## Config

Config is loaded by a **dependency-free `.env` parser** in
[src/config.js](src/config.js) (no `dotenv`); a variable already set in the
environment wins over the `.env` file (so Docker/compose `environment:` values
override it). Every variable is documented, grouped into six labeled sections, in
[.env.example](.env.example); [docker-compose.yml](docker-compose.yml) mirrors
the same grouping. `config.js` **must stay at `src/`** — its `ROOT` is derived
from its own location and resolves the data dir, music file and `.env` path.

## Security

The model is deliberate; preserve it when editing.

- **Capability-URL access, no user login.** A channel is reached only via an
  unguessable nanoid **stream token** in the URL (`/u/:token/...`). The token
  *is* the credential, so the URLs are secrets. Prefer the path form
  `/u/:token/...` over `/playlist.m3u?token=` / `/epg.xml?token=` — query strings
  leak via access logs / `Referer` / proxies — and require TLS off-LAN
  (`PUBLIC_BASE_URL` should be `https://` there).
- **Separate `notify_token`.** The on-screen sign-up QR points at `/sub/:token`
  using a *distinct* token, so photographing the QR can't grant stream access.
  Keep the two token namespaces strictly separate.
- **Admin auth = HMAC(admin password) cookie** keyed by `SESSION_SECRET`
  (HttpOnly, SameSite=Lax); rotating `ADMIN_PASSWORD` invalidates all sessions.
  `/admin/login` is per-IP rate-limited.
- **Double opt-in email** (`verified:false` + single-use `verify_token`; no real
  mail until verified) so the flow can't mail an unconsenting address. `/sub`
  write endpoints are per-IP + per-token rate-limited so the confirmation mail
  can't be a spam relay; set `TRUST_PROXY` behind a proxy so the limiter sees
  real client IPs (and can't be spoofed when directly exposed).
- **No outbound SMTP** (mail over an HTTPS API), **atomic DB writes** +
  corrupt-file backup, **`x-powered-by` disabled**, and the container runs as the
  **non-root `node`** user (a bind-mounted `./data` must be writable by uid 1000).
- **CSRF:** mutating `/admin/api` calls require an `X-CSRF-Token` header echoing
  the token from `/api/state` (derived like the session cookie, distinct label).
  A cross-site page can neither read `/api/state` nor set the custom header, so it
  can't forge a valid token even though the browser auto-sends the session cookie.

## Deployment

Production runs as a Docker container on a DigitalOcean droplet. See the
deployment note in the memory index (`memory/MEMORY.md`) for host, image,
Portainer stack and port specifics rather than duplicating them here.
