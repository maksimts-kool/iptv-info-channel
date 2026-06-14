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
[src/overlay.js](src/overlay.js)). Keep that language when editing visuals.

## Commands

```bash
npm start            # run server (src/server.js)
npm run dev          # run with --watch (auto-restart on file change)
npm run seed         # create 3 demo users (no-op if any user exists)
npm test             # run all tests (node --test, built-in runner)
node --test test/util.test.js   # run a single test file

docker compose up -d --build           # build + run the container
docker compose logs -f m3u-info        # follow runtime logs
docker compose exec m3u-info npm run seed
```

No build step, no linter, no TypeScript. Pure ESM (`"type": "module"`), Node
20+. Tests use the built-in `node:test` runner and only cover the two pure-logic
modules (`util`, `liveloop`); the ffmpeg/render path has no automated tests.

External requirement: **ffmpeg must be on PATH** (override with `FFMPEG_PATH`).
The Docker image installs it plus the Inter font for Cyrillic rendering.

## Architecture

Request/data flow, entry point [src/server.js](src/server.js):

1. **Data** — [src/db.js](src/db.js) is a JSON-file store, **not** a real
   database (the project predates this and some history/comments still say
   "SQLite"). State lives in `DATA_DIR/db.json` (`plans`, `users`, `incidents`,
   `settings`) with atomic writes (tmp + rename) and a corrupt-file
   backup-and-reset path. Users
   are decorated with their plan's fields on read (mimics an old SQL join).
   Access tokens are unguessable nanoid strings; there is no user login, only
   the per-user URL token and the single admin password.

2. **Render** — [src/overlay.js](src/overlay.js) builds the channel frames as
   **SVG** and rasterizes to PNG with `sharp`. Frames: a brand intro slide; a
   "body" that is the account card (`buildCardSvg`) or, for expired accounts, an
   auto-layout plans grid (`buildExpiredPlansSvg`); and (when
   `STATUS_SLIDE_ENABLED`) a global Better Stack–style status board
   (`buildStatusSlideSvg`, fed by `statusSummary()` in
   [src/status.js](src/status.js)). In the final days before expiry the card
   swaps its lower half for a compact "продлите подписку" plan strip
   (`buildRenewingCardSvg`); healthy cards are unchanged. On the **final valid
   day** (and once expired) the body becomes the full plans grid instead — same
   `buildExpiredPlansSvg`, with a `variant: 'lastDay'` orange "ПОСЛЕДНИЙ ДЕНЬ"
   header vs. the red "ПОДПИСКА ИСТЕКЛА" one. `buildBodySvg` owns this routing.
   All SVGs use a fixed 1280×720 viewBox scaled to the configured output
   resolution.

3. **Encode** — [src/channel.js](src/channel.js) spawns **ffmpeg** to turn the
   PNG(s) + looped music into HLS segments. Two paths: an intro path
   (slide → `xfade` transition → card, low fps) and a plain still-card path
   (intro disabled, very low fps). When the status slide is enabled each path
   gains a **third frame** (intro: a chained `xfade` into the status board;
   still: a `concat` card → status) — the frame durations are sized so the loop
   total stays ≈ `CHANNEL_DURATION` and still tiles onto `hlsTime` boundaries
   with no runt segment. A bottom-right "Далее через N" countdown to the next
   slide change is baked in via `drawtext` (`slideTimerFilters`, toggle
   `SLIDE_TIMER_ENABLED`); it needs a font ffmpeg can resolve — fontconfig
   `Inter` by default (the image installs `fonts-inter`), or `TIMER_FONT_FILE`.
   Note the drawtext escaping: colons inside `%{eif:…:d}` must be `\:` because
   ffmpeg strips the surrounding quotes before splitting options on `:`. Key
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

4. **Serve as live** — [src/liveloop.js](src/liveloop.js) presents the
   pre-generated finite VOD asset as an **endless live HLS channel**: a sliding
   window over the looped segments with monotonically increasing media/
   discontinuity sequence numbers (they must never move backwards across a
   regeneration — see `previousPosition` handling in channel.js). All viewers
   share one live timeline: tuning in joins the stream wherever it currently is,
   it never restarts at the intro on channel open. (The brand intro slide, when
   `INTRO_ENABLED`, is just ordinary loop content baked in by channel.js — it
   only shows when the shared loop cycles past it.)

5. **Public endpoints** — [src/routes/stream.js](src/routes/stream.js):
   `/u/:token/playlist.m3u` (and `/playlist.m3u?token=`) return the `.m3u`;
   `/hls/:token/:file` lazily generates (on first request) and serves the
   `index.m3u8` live playlist + `.ts` segments. Segment requests honor HTTP
   `Range` (strict players probe with `Range:` and stall on a plain 200).

6. **Admin** — [src/routes/admin.js](src/routes/admin.js) is a cookie-auth JSON
   API under `/admin/api` plus static UI in `src/public/admin/`. Auth
   ([src/middleware/auth.js](src/middleware/auth.js)) is an HMAC of the admin
   password stored in the cookie, so changing `ADMIN_PASSWORD` invalidates all
   sessions. Most mutations trigger **fire-and-forget** regeneration; note that
   plan, branding and **incident** edits regenerate **all** users (expired users
   render every available plan; the status slide is global), while user edits
   regenerate just that user. Incidents (`/admin/api/incidents`, states
   `degraded`/`outage`) drive the status board's 90-day uptime strip.

## Things that bite

- **HLS player compatibility is fragile.** Strict players (Televizo's
  ExoPlayer/IJK) buffer forever unless the live playlist keeps a ≥8-segment
  window (`LIVE_WINDOW_SEGMENTS`), drops sub-second "runt" trailing segments,
  emits `#EXT-X-VERSION:6`, and the server supports `Range`. Lenient players
  (OTT Play) tolerate less of this. Don't "simplify" the liveloop playlist
  construction without testing on a strict player.
- **`PUBLIC_BASE_URL` is baked into generated `.m3u` URLs.** On a LAN it must be
  the host IP reachable by the IPTV box, never `localhost`.
- **Timezone matters.** Day-counting, expiry, the daily cron, and displayed
  dates all use `TZ` (default `Europe/Tallinn`) via `Intl.DateTimeFormat`, not
  raw `Date` math. An account stays valid through 23:59 on its expiry date.
- Config is loaded by a **dependency-free `.env` parser** in
  [src/config.js](src/config.js) (no `dotenv`); env vars already set win over
  the file.

## Deployment

Production runs as a Docker container on a DigitalOcean droplet. See the
deployment note in the memory index (`memory/MEMORY.md`) for host, image,
Portainer stack and port specifics rather than duplicating them here.
