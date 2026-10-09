# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-customer **IPTV subscription server**. The admin points it at one or
more provider `.m3u` URLs, curates the resulting channel catalog (rename,
re-group, enable/disable), and each customer gets a private `.m3u` built from
that catalog. **A plan is a channel package**: it holds the list of catalog
categories its customers receive, with **per-customer exceptions** on top.

Every customer playlist also carries a built-in **Информация** category holding
that customer's personal looping **HLS info channel** (plan, price, expiry, days
left, colour-coded status over background music). When a subscription expires,
Информация is the *only* thing left in their playlist. Next to it sits a second
built-in channel, the **media channel** («Медиа»): admin-written articles
(rich text with images and videos inside), shown one after another, shared by
every customer (see Architecture 11). The info channel
was the original product and is now one feature inside the playlist server —
weight new work accordingly.

Ships with a password-protected web admin (`/admin`) and a Docker image
(Node + ffmpeg).

UI strings on the rendered cards, status labels and the whole admin UI are
**Russian** (see `STATUS_META` in [src/core/util.js](src/core/util.js) and the SVG text in
[src/render/overlay.js](src/render/overlay.js)). Keep that language when editing visuals.

## Layout

Source is grouped by concern, **all folders exactly one level under `src/`**, and
only two files are allowed to sit loose at `src/` — the entry point and the
config module (its `ROOT` is derived from its own location). Everything else
belongs in a concern folder; put new modules there rather than at the root.

```
src/
  server.js            # express wiring, landing, health, shutdown (entry point)
  config.js            # .env parser + typed config (ROOT lives here — do not move)
  core/    logger.js util.js audience.js          # cross-cutting primitives:
                       #   logger.js  structured logger
                       #   util.js    formatters (dateFormatter), STATUS_META, xmlEscape
                       #   audience.js a group of customers {users, plans} (private media, newsletter)
  data/    store.js seed.js                       # JSON-file store + its CLI shim:
                       #   store.js   users/plans/incidents/subscribers/payments/newsletters (+ seedDemo)
                       #   seed.js    `npm run seed` -> store.seedDemo()
  notify/  notify.js                              # email notifications (transport, templates, dispatch)
  playlist/ m3u.js model.js catalog.js hls.js devices.js # provider m3u + the channel catalog
                       #   hls.js     rewrite a provider HLS manifest + mid-view splice (gateway)
                       #   devices.js simultaneous-device tracker (gateway)
  render/  overlay.js status.js article.js media.js # SVG frames + their data models:
                       #   article.js article document -> satori layout trees (pure)
                       #   media.js   article page / corner chip -> PNG (satori + sharp)
  encode/  channel.js liveloop.js ffmpeg.js media.js # ffmpeg encode + live HLS window:
                       #   ffmpeg.js  spawn helpers shared by both channels
                       #   media.js   media-channel clip/loop arg builders (golden-pinned)
  media/   doc.js variants.js store.js build.js   # the media channel:
                       #   doc.js     article schema: sanitize, assets, private sections, split at videos (pure)
                       #   variants.js who sees what: per-viewer articles, variant keys (pure)
                       #   store.js   articles + assets (Settings `media_channel`), files, disk budget
                       #   build.js   video queue, per-article clip cache, debounced build of every variant loop
  http/    stream.js subscribe.js admin.js catalog.js media.js auth.js # all HTTP surfaces
  epg/     epg.js epgfoss.js xxhash32.js          # XMLTV + OTT-play FOSS guides
  news/    notices.js providernews.js             # provider service notices on the status slide:
                       #   notices.js      pure: feed HTML -> notices, filter, cookie jar
                       #   providernews.js settings, fetch + session refresh, watcher
  public/admin/        # built admin UI (Vite output from ../frontend; served by http/admin.js)
```

`test/` **mirrors that tree** — a test lives in the folder named after the `src/`
folder it covers (`test/http/catalog-route.test.js` covers `src/http/`), with
shared fixtures in `test/fixtures/`. `npm test` is a bare `node --test`, which
recurses, so a new subfolder needs no wiring.

```
frontend/              # React + Vite + Ant Design admin app (own package.json)
  src/main.jsx         # entry
  src/App.jsx          # sider shell + hash routing
  src/lib/             # api.js (fetch wrapper + AuthError), plans.js, format.js, audience.js
  src/pages/           # one component per nav section (Overview/Playlist/Clients/Payments/Devices/…)
  src/playlist/        # SourcesPanel + CatalogPanel (categories with channels nested)
  src/clients/         # the per-customer drawer and its tabs
  src/components/      # Login, RegenBanner, ChannelHeader, AudiencePicker, and the
                       #   Plans/Branding/Incidents/Notify/Newsletter/Gateway cards
  src/media/           # Медиаканал: ArticleList (dnd-kit), ArticleEditor (TipTap) + toolbar,
                       #   image/video nodes (mediaNodes.js + MediaNodeView), the private-section
                       #   node (privateSection.js + PrivateSectionView), upload helper
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
node --test test/core/util.test.js   # a single test file
```

No build step, no linter, no TypeScript on the backend. Pure ESM
(`"type": "module"`), Node 20+. Tests use the built-in `node:test` runner and
cover the pure-logic modules (`util`, `encode/liveloop`, `epg/epg`,
`epg/epgfoss`, `render/status`, `epg/xxhash32`, `playlist/m3u`,
`playlist/model`, `playlist/hls`, and the `.m3u`-playlist builders plus the
admin/catalog-domain pure fns living in `http/`) plus route/integration tests for the FOSS endpoints
and, in [test/http/catalog-route.test.js](test/http/catalog-route.test.js), a full pass
over the catalog through the real routers with a throwaway `DATA_DIR` (import a
provider playlist from a local stub server, curate it, personalise a customer,
assert the resulting `.m3u` — including the expiry gate). That file sets
`FFMPEG_PATH` to a non-existent binary so the fire-and-forget info-channel
encodes fail instantly instead of racing its teardown. The frontend has no
backend tests (it is a client rewrite against `/admin/api`). The
ffmpeg encode has no live render test, but
[test/encode/channel-args.test.js](test/encode/channel-args.test.js) pins the exact ffmpeg
argv against a golden snapshot so the arg builders can be refactored safely (the
rationale + how to regenerate the golden live in a comment atop the builders in
[src/encode/channel.js](src/encode/channel.js)). The `.dockerignore` deliberately
ships `test/` into the image so the suite runs in the `test` compose service.

## Architecture

Request/data flow, entry point [src/server.js](src/server.js):

1. **Data** — [src/data/store.js](src/data/store.js) is a JSON-file store, **not** a real
   database (the project predates this and some history/comments still say
   "SQLite"). State lives in `DATA_DIR/db.json` (`plans`, `users`, `incidents`,
   `subscribers`, `payments`, `newsletters`, `settings`) with atomic writes (tmp + rename) and a
   corrupt-file backup-and-reset path. Users
   are decorated with their plan's fields on read (mimics an old SQL join).
   Access tokens are unguessable nanoid strings; there is no user login, only
   the per-user URL token and the single admin password. `seedDemo()` (the
   `npm run seed` helper) also lives here.

   A **plan carries `category_ids`** — the catalog categories it sells. Plans
   used to carry a free-text `features` list; that key is now *derived* (the
   granted categories' names, via `describePlans` in `playlist/catalog.js`) so
   `render/overlay.js` keeps rendering a plain `features` array and needs no
   knowledge of the catalog. Old records keep their stale `features` array on
   disk; nothing reads it.

   The **channel catalog is a second store**
   ([src/playlist/catalog.js](src/playlist/catalog.js), `DATA_DIR/catalog.json`)
   with the same atomic-write/corrupt-backup behavior — kept separate because a
   provider list runs to tens of thousands of channels and both stores rewrite
   the whole file on every save, so one customer's expiry edit must not rewrite
   megabytes of channel rows.

2. **Playlist catalog** — the primary domain, three files under `src/playlist/`:
   - [m3u.js](src/playlist/m3u.js) parses/serializes **provider** extended-M3U
     text (not the HLS media playlists in `encode/liveloop.js` — don't confuse
     them). Handles the real-world quirks: the title is split at the last comma
     *outside quotes* (attribute values contain commas), `group-title` beats a
     separate `#EXTGRP:` line, and `#EXTVLCOPT`/`#KODIPROP`/`#EXTHTTP`
     directives are kept verbatim and re-emitted because they are load-bearing
     for playback.
   - [model.js](src/playlist/model.js) is the **pure** logic: `ensureBuiltins`
     (the `Информация` category + info channel), `mergeSourceChannels`,
     `resolveUserChannels`, `resolveChannelAccess` (the same decision for one
     channel, for the stream gateway) and the auto-refresh due calculation
     (`sourceDueAt`/`sourceIsDue`). No I/O, no module state — unit-tested directly.
   - [catalog.js](src/playlist/catalog.js) is the store + HTTP fetching:
     `Sources`, `Categories`, `Channels`, `Overrides`, `queryChannels`
     (server-side paging/filtering), `refreshSource`/`refreshAllSources`/
     `refreshDueSources` and the `startSourceAutoRefresh` scheduler.

   **Sources refresh themselves.** Each source row carries `auto_refresh` and
   `interval_hours` (admin-managed, alongside `last_sync_ms` — stamped on every
   *attempt*, success or failure, so a dead provider is retried on its interval
   rather than on every tick). `startSourceAutoRefresh()` (wired in
   `server.js`, gated on `CATALOG_AUTO_REFRESH`) polls every
   `CATALOG_REFRESH_CHECK_MINUTES` and refreshes whatever has come due; the
   00:05 cron calls the same `refreshDueSources` as a safety net for intervals
   that elapsed while the process was down. The polling tick is *not* the
   refresh interval — that is per source.

   Invariants worth preserving:
   - **Admin edits beat upstream.** A refresh updates only the stream URL and
     the passthrough attributes/directives; a rename, a category move and a
     disable all survive. Channel identity is `tvg-id` when the provider ships
     one, else the stream URL, scoped per source — so a rotated access token in
     the URL doesn't duplicate the channel.
   - **Vanished channels are flagged `missing`, never deleted**, so a truncated
     download can't destroy the admin's overrides; they return on reappearance.
     For the same reason the admin UI offers **no delete for an imported**
     channel or category — the next refresh would just bring it back, so the
     honest control is the enable switch. Only rows created by hand (`custom`)
     can be deleted; the `DELETE` routes still exist and still work for those.
   - **A category's visibility has three layers**, resolved by
     `categoryEnabledFor` in priority order: (1) a **per-customer pin**, (2) the
     **global enable** (catalog-wide kill switch), (3) the **plan** — whether
     `plan.category_ids` includes it. A pin is authoritative in both directions:
     `false` takes away a category the plan grants, `true` grants one it
     doesn't, absent follows the plan. Channels have only the first two layers
     (`effectiveEnabled`) and are additionally gated by their category.
   - **A plan with an empty `category_ids` grants nothing** — deliberately, so a
     provider adding a category never silently ships it to every customer. The
     cost is a real setup cliff, so the empty-plan and unsold-category cases are
     flagged on the Обзор, Тарифы and Категории screens rather than left silent.
     Deleting a category must also call `Plans.removeCategory` (see
     `http/catalog.js`) so no plan references a category that is gone.
   - **A playlist is a one-shot grant unless the gateway is on.** The `.m3u`
     normally carries the provider's own stream URLs, so the player talks
     straight to the provider and this server never learns a channel was opened
     — a customer who lost a category keeps watching until their player
     re-downloads the playlist, which many players only do on demand. With
     `config.gateway.enabled` (env `STREAM_GATEWAY_ENABLED`, overlaid by the
     admin's `gateway_enabled` setting via `syncGatewaySettings()` in
     `http/stream.js`) every **HLS** channel is published as `/c/:token/:id.m3u8`
     instead, and that route re-runs `resolveChannelAccess` on **every request**
     before returning the provider's manifest with its URIs rewritten to
     absolute provider URLs (`playlist/hls.js`). Only the manifest passes
     through — segments still go provider → player — and because a player
     re-fetches a live media playlist every few seconds, a revocation lands
     mid-view rather than at the next zap. Four things to preserve:
     - **The gate must not answer with a cross-protocol redirect.** Its first
       implementation `302`'d to the provider; with this server on https and the
       provider on http, ExoPlayer/media3 (so: every Android player, including
       OTT-play on a phone) refuses to follow it by default and the channel
       buffers forever, while desktop players follow it happily and hide the
       bug. Serving the manifest is what removes the redirect. **A raw MPEG-TS
       channel has no manifest**, so it is deliberately *not* gated at all
       (`channelStreamUrl` returns the provider URL) rather than gated with a
       redirect that half the customers cannot play. `/api/state` reports the
       gateable count so the admin can see the split.
     - **The published gate URL must end in `.m3u8`.** ExoPlayer picks its media
       source from the URL *extension* (`Util.inferContentType`), not from the
       `Content-Type` we send, so an extensionless link makes it fetch a
       perfectly good manifest and then decode it as a progressive media file:
       a black screen with no error, again only on Android. The route strips the
       suffix and still answers the extensionless form, because playlists issued
       before it existed are still in players.
     - `resolveChannelAccess` must keep agreeing with `resolveUserChannels` row
       for row (pinned by a test that walks the whole catalog) — the `.m3u`
       lists what one allows and the gate re-checks with the other.
     - **The `/c/` route is deliberately not gated on the flag**, and it still
       redirects for non-HLS URLs. Playlists handed out while the flag was on
       stay in players indefinitely; switching the feature off, or narrowing
       what gets gated, must not break them.
     - A refused channel redirects to the customer's **own info channel** (same
       origin, so no cross-protocol problem), not a 403: in a player a 403 is an
       indistinguishable "cannot play", i.e. a support ticket, while the card
       explains what the subscription covers.
     - **Variants go through the gate too.** A player fetches a master
       playlist once and then only refreshes the chosen variant, so when the
       master handed out direct provider variant URLs a revocation landed only
       at the next zap. The master's variant lines and `EXT-X-MEDIA` URIs are
       now rewritten (`rewriteHlsManifest(…, { playlistUri })`) to
       `/c/:token/:tag/:id/:sig/:ref.m3u8`, where `ref` is the base64url
       upstream URL and `sig` an HMAC (`SESSION_SECRET`) over token + channel +
       URL — without the signature the route would be an open fetch proxy.
     - **A mid-view refusal is a splice, not a redirect.** Redirecting a media
       playlist refresh to another live stream hands the player unrelated
       sequence numbers (ExoPlayer: stuck playlist / behind-live-window). The
       gate instead keeps per-player state (in memory, `sessions` in
       `http/stream.js`: last media window served) and answers with
       `buildSplicedPlaylist`: the provider's last window, a discontinuity,
       then our own loop (info card, or the device-limit notice) numbered as the
       continuation. Same invariants as `liveloop.js` (monotonic sequence, one
       discontinuity number per sequence, no tag on the window's first
       segment), pinned by a test that walks refreshes. The cut-over is sticky
       until a fresh tune-in (a gap of several target durations, or the master
       being fetched again). fMP4 (`EXT-X-MAP`) providers get `EXT-X-ENDLIST`
       instead — TS segments can't follow an init section. A refusal with no
       prior window (tune-in, or after a restart) is still the 302 to the card.
     - **Device limit** (`playlist/devices.js`): `plan.max_devices` (0 =
       unlimited) with a per-user `max_devices` override (`null` = plan),
       resolved as `device_limit` in `decorate`. Every allowed gated manifest
       fetch refreshes the device's slot; a slot frees
       `STREAM_DEVICE_IDLE_SECONDS` after the last fetch; earliest arrivals win.
       A device = IP + a **tag of the playlist downloader's User-Agent** baked
       into the gate path (`/c/:token/:tag/:id.m3u8`) — not the per-request UA,
       because apps often probe with okhttp and play with ExoPlayer and that
       would count one TV twice. Over-limit tune-ins 302 to the global
       `/notice/devices/` loop (`ensureDeviceNotice` in `encode/channel.js`);
       watching players over the limit are spliced onto it. Tracker state is
       in memory only.
     The gateway controls what *plays*, not what is *listed* — a newly added
     channel still appears only when the player re-downloads the playlist.
   - **The expiry gate is derived, never persisted.** `resolveUserChannels`
     takes a `locked` flag (account expired or deactivated) and collapses the
     list to the built-in `Информация` category (the account channel, plus the
     media channel when it is on). Nothing is written when an
     account lapses, so a renewal restores everything on the next request and
     can't drift out of sync with a stored "disabled everything" flag. The
     built-in category therefore cannot be deleted, switched off, or withheld
     from a customer, and the info channel cannot be moved out of it — the
     guards for that live in `Categories.update`, `applyChannelFields` and
     `http/catalog.js`.

3. **Render** — [src/render/overlay.js](src/render/overlay.js) builds the channel frames as
   **SVG** and rasterizes to PNG with `sharp`. Frames: a brand intro slide; a
   "body" that is the account card (`buildCardSvg`) or, for expired accounts, an
   auto-layout plans grid (`buildExpiredPlansSvg`); and (when
   `STATUS_SLIDE_ENABLED`) a global Better Stack–style status board
   (`buildStatusSlideSvg`, fed by `statusSummary()` in
   [src/render/status.js](src/render/status.js)). In the final days before expiry the card
   swaps its lower half for a compact "продлите подписку" plan strip
   (`buildRenewingCardSvg`); healthy cards are unchanged. On the **final valid
   day** (and once expired) the body becomes the full plans grid instead — same
   `buildExpiredPlansSvg`, with a `variant: 'lastDay'` orange "ПОСЛЕДНИЙ ДЕНЬ"
   header vs. the red "ПОДПИСКА ИСТЕКЛА" one. `buildBodySvg` owns this routing.
   All SVGs use a fixed 1280×720 viewBox scaled to the configured output
   resolution.

   **Provider service notices** ([src/news/](src/news/)) ride on the status
   slide as `summary.providerNotices`: the upstream provider's news feed
   (tv.team `/v3/news`, behind a cookie login the admin pastes once; a 401
   triggers `/v3/auth/refresh` and the rotated cookies are persisted in Settings
   `provider_news`) is polled by `startProviderNewsWatcher`, and only
   maintenance/outage items pass `isServiceNotice` — channel launches and
   removals are news, not status, and must stay out. `withProviderNotices` (render/status.js) mixes
   them into the summary — also for `/api/state` — so they share **one event
   list** with our incidents, always blue with a megaphone, and when our own
   state is `operational` the overall state becomes `provider` (blue instead of
   green; our degraded/outage still wins, uptime is untouched). With notices the
   slide switches to a condensed board + that event list; with none it is
   byte-identical to the classic board. The admin lists them read-only inside
   the «Статус сервиса» card; `ProviderNewsCard` holds only the switch + cookie
   + OpenRouter key. With a key, `news/aisummary.js` replaces each body with a
   one-line LLM retelling of the notice's full `text` (model `openrouter/free`);
   summaries are cached in Settings `provider_news.summaries` by notice id +
   text hash, so the model is asked **only when the original text changes**, and
   a failure falls back to the parser body and retries next poll. The key is a
   credential like the cookie (same `provider_news` key, never sent to the
   browser — only `ai_key_set`). A failed fetch keeps the previous
   notices (they age out after `PROVIDER_NEWS_MAX_AGE_HOURS`), and any change to
   what the slide shows rebuilds all streams once (`consumeShownChange`). The
   session cookie is a credential: `/api/state` goes through `publicSettings`.

4. **Encode** — [src/encode/channel.js](src/encode/channel.js) spawns **ffmpeg** to turn the
   PNG(s) + looped music into HLS segments. Two paths: an intro path
   (slide → `xfade` transition → card, low fps) and a plain still-card path
   (intro disabled, very low fps). Each enabled global slide (currently just the
   status board) is appended as **another frame** — the intro path chains
   more `xfade`s, the still path adds more `concat` inputs (`introWithExtrasArgs`
   / `stillFfmpegArgs` take an ordered `extras` list; the list shape is kept
   rather than collapsed to the single slide so another global frame stays cheap
   to add). Each slide holds for its
   own configured duration — the account card for `ACCOUNT_SLIDE_SECONDS`, just like
   the intro/status slides set their own — and the loop total is their
   sum, rounded to a whole number of `hlsTime` segments (`tileToSegments`)
   so the looped VOD tiles cleanly with no runt segment; the still card absorbs
   the sub-segment rounding slack. **The exported arg builders
   (`introFfmpegArgs`/`stillFfmpegArgs`) are pinned by a byte-identity snapshot
   ([test/encode/channel-args.test.js](test/encode/channel-args.test.js)); a comment atop them
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
   - **Daily cron** at 00:05 (`startDailyRefresh`) first re-downloads every
     enabled playlist source (when `CATALOG_AUTO_REFRESH`), then rebuilds every
     stream so the "days left" counter and expiry status stay current.

5. **Serve as live** — [src/encode/liveloop.js](src/encode/liveloop.js) presents the
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

   A second invariant sits next to the monotonic counters: **one media sequence
   number always reports the same discontinuity number** (`DISCONTINUITY-SEQUENCE`
   + the tags ahead of it). The wrap tag is therefore emitted only *inside* the
   window, never before its first segment — that position is already what
   `DISCONTINUITY-SEQUENCE` states, and counting it twice renumbered the segment
   as the window slid onto the boundary, which froze ExoPlayer at every loop
   wrap. Pinned by a test that walks the window across several wraps.

   Because the window is 8 segments, **a loop shorter than `8 × HLS_TIME`
   would be repeated inside a single playlist** (same segments listed twice,
   one or two wrap discontinuities in every response — a viewer permanently on
   a PTS restart). `tileToSegments` in `encode/channel.js` therefore floors the
   loop at one window whenever `CHANNEL_LIVE_LOOP` is on, and the account card
   takes up the slack exactly as it takes the rounding slack. The visible
   consequence is that short slide settings stretch the card: at `HLS_TIME=6`
   nothing rotates faster than 48s, so **lower `HLS_TIME` — not the slide
   seconds — to speed the rotation up**. The floor is above every golden
   profile, so it leaves the pinned ffmpeg argv untouched.

6. **Public endpoints** — [src/http/stream.js](src/http/stream.js) (which merges the
   former `routes/stream.js`, `playlist.js` and `routes/foss-epg.js`):
   `/u/:token/playlist.m3u` (and `/playlist.m3u?token=`) return the `.m3u` — the
   customer's **whole channel list**, resolved from the catalog on every request
   (no caching, no pre-build) by `renderUserPlaylist`, which applies the expiry
   gate and hands the resolved entries to the pure exported `buildUserPlaylist`.
   Upstream `url-tvg` guides from the sources that actually contributed channels
   are appended comma-separated after ours.
   `/hls/:token/:file` lazily generates (on first request) and serves the
   `index.m3u8` live playlist + `.ts` segments. Segment requests honor HTTP
   `Range` (strict players probe with `Range:` and stall on a plain 200).
   `/c/:token/:channelId` is the **stream gateway** (see the catalog invariants
   above): it re-resolves entitlement per request and returns the provider's
   rewritten HLS manifest, or `302`s to the customer's own `/hls/` loop when the
   answer is no.
   `/u/:token/epg.xml` (and `/epg.xml?token=`) return the **XMLTV programme
   guide** (see EPG below); the `.m3u` header advertises it via `url-tvg` and the
   `#EXTINF` of the **info channel** uses a per-user `tvg-id`
   (`account-<token>`) matching the EPG `<channel id>`; imported channels keep
   the provider's own `tvg-id`. When `EPG_FOSS_ENABLED`, the same module's
   `createFossEpgRouter`/`fossEpgRouter` additionally serves the
   OTT-play FOSS endpoints — `/foss-epg/u/:token/{channels.json,epg/<hash>.json,
   logo.svg}` plus the `/m3u/match-channels` and `/m3u/match-logos` match
   protocol (see FOSS below).

7. **EPG** — [src/epg/epg.js](src/epg/epg.js) (`buildEpgXml`) synthesises a per-user
   XMLTV guide. There's no real schedule (the channel is a looping card), so it
   emits **one `<programme>` per calendar day** over a window
   (`EPG_DAYS_BEHIND`..`EPG_DAYS_AHEAD` around "today").

   **A player shows exactly one line of this: the programme `<title>`.** That
   line is the reason the guide exists, so it is the *customer's own*
   subscription status (`✓ Подписка активна · ещё 89 дней`, `⚠ Подписка
   истекает · последний день`, `✕ Подписка истекла`, `✕ Аккаунт отключён`),
   sampled at that day's local noon so it decrements across the guide. The
   day's service state (from `severityForDay`) is **prefixed onto that same
   line only when it is not `operational`** (`⚠ Перебои в работе · …`) — an
   incident must never be invisible, and a healthy service must never crowd out
   the account status. `<sub-title>` is the concrete expiry date and `<desc>`
   adds the plan + price, the full service headline, 90-day uptime and incident
   details. Don't move the account status back out of the title: putting the
   (usually boring) service headline there is what made the guide useless in
   Televizo/OTT-play.

   Pure logic, unit-tested ([test/epg/epg.test.js](test/epg/epg.test.js)) and
   built **live on request** (not pre-encoded) so days-left/status stay fresh
   without regeneration. Timestamps are local-midnight XMLTV
   (`YYYYMMDDHHMMSS +ZZZZ`) with a DST-correct offset; interpolated text is
   XML-escaped. Toggle with `EPG_ENABLED` (disabling also drops `url-tvg`).

   The per-day records are produced once by `eachEpgDay` — semantic data plus
   the **already-rendered `title`/`desc`**, so the XMLTV and OTT-play FOSS
   guides physically cannot tell one customer two different things; each
   renderer only formats the day bounds into its own timestamp shape.

8. **FOSS EPG (OTT-play)** — [src/epg/epgfoss.js](src/epg/epgfoss.js) renders a
   token-scoped JSON guide that OTT-play FOSS fetches **directly**
   (`channels.json` + `epg/<xxhash32(tvg-id)>.json`), bypassing the central
   matcher. Its `name`/`descr` are the shared `eachEpgDay` `title`/`desc` — the
   same pair XMLTV puts in `<title>`/`<desc>`. (`descr` was previously hardcoded
   to `''`, which left every OTT-play viewer with no account status at all.)

   **The `foss-tvg` URL must end at `epg/`** (`fossEpgDirUrl` in `http/stream.js`,
   not `fossProviderBaseUrl`). In the `=` static mode the player appends
   `<xxhash32(tvg-id)>.json` to the advertised string *verbatim* — the documented
   reference is `=iptvx::http://epg.ottp.eu.org/iptvx.one/epg/` against the real
   file `.../iptvx.one/epg/890122.json` — so advertising the token base one level
   up (this server's original bug) requests a 404 and the channel shows nothing.
   The `/m3u/match-channels` provider block is the one place that *does* name the
   level above, because there the player adds the `epg/` itself (the reference
   matcher answers `<base_url><provider id>/`); keep those two apart.
   The protocol is documented at <https://ottp.eu.org/www/manuals/epg/custom/>.

   **Two different hashes, and getting either wrong means silently no EPG:**
   - `fossIdHash` — the channel-id hash naming `epg/<hash>.json`, xxhash32 of the
     **lowercased** `tvg-id` (the converter's `HashSting32i`).
   - `fossUrlHash` — the `meta.url-hashes` entries, xxhash32 of the `url-tvg`
     with the scheme cut off and **no** case folding (`HashSting32` ∘ `CutHTTP`).
     This is the binding: OTT-play hashes the playlist's own `url-tvg` and only
     applies a provider declaring that hash, so `url-hashes: []` — what this
     server used to publish — means the guide is never used at all. `channels.json`
     is therefore built with the **exact** `url-tvg` string the `.m3u` carries;
     both come from `userEpgUrl()` in `http/stream.js` for that reason, and
     `fossLogoUrl()` likewise feeds both `tvg-logo` and the icon field of the
     `channels.json` row (`"<tvg-id>¦<last-epg>¦<icon>"`).

   Both hash rules are pinned by tests against OTT-play's **live** reference
   providers (`https://epg.ottp.eu.org/<id>/channels.json`) — e.g.
   `fossUrlHash('iptvx.one/EPG') === 2853413468`. Re-verify against a live
   provider before touching them; they are not free to "normalize". [src/epg/xxhash32.js](src/epg/xxhash32.js) reproduces OTT-play's Go
   `OneOfOne/xxhash` so the per-channel id hashes match byte-for-byte (pinned by
   vector tests — don't swap it for a generic hash lib). The route (in
   `http/stream.js`) also proxies/merges the upstream OTT-play `match-channels`
   response so this server works as a drop-in `!epg-server` in a combined
   playlist. Pure logic is unit-tested; toggle with `EPG_FOSS_ENABLED`
   (`EPG_FOSS_PROVIDER_ID`, `EPG_FOSS_UPSTREAM_MATCH_URL`). See the README for the
   `.m3u` attributes and the **leading-`=`** requirement on `foss-tvg`/`tvg-source`.

9. **Email notifications** — [src/notify/notify.js](src/notify/notify.js) is the whole feature
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
   instead of sending. Five triggers: **server status** (admin incident
   raised/resolved, opt-in), **expiring soon** (`expirySweep()` from the daily
   cron, opt-in, once per expiry date via a `last_expiry_notice` dedup marker),
   **renewal** (admin pushes expiry later, or records a payment — mandatory),
   and **content** (the customer's channel package changed — opt-in, the
   `content` option; subscribers predating the topic are grandfathered on),
   and the admin's **newsletter** (news / important announcements — opt-in, the
   `news` option, grandfathered on the same way). A newsletter goes to every
   verified `news` subscriber or to an **audience** (`core/audience.js`: customer
   ids and/or plans); `newsletterRecipients` is the pure rule, the UI computes
   the same count before sending. `POST /api/newsletters` refuses (409) while
   mail is off or nobody would receive it, records the newsletter
   (`Newsletters`, status `sending` → `sent`) and dispatches in the background;
   `important` only changes the look, it is still opt-in mail.
   The content trigger fires from two places and both diff **effective
   visibility**, never the raw edit, so a change the customer cannot see mails
   nothing: a plan's `category_ids` edit (`planCategoryDiff` in `http/admin.js`,
   skipping customers who have pinned that category and locked accounts) and a
   personal exception (`diffOverridePatch` in `http/catalog.js`). Data lives in `data/store.js`
   (`Subscribers`, one per `user_id`; `NotifyLog` capped ring buffer); the global
   on/off flag is a `Settings` value (`notify_enabled`) overlaid onto
   `config.notify.enabled` by `syncNotifySettings()` (an admin
   toggle overlaid onto the env default). The `/sub` write endpoints are rate-limited (per-IP + per-token) so
   the confirmation email can't be used as a spam relay. Pure logic is
   unit-tested ([test/notify/notify.test.js](test/notify/notify.test.js)); the admin card lives
   in `src/public/admin/`.

10. **Admin** — [src/http/admin.js](src/http/admin.js) is a cookie-auth JSON
   API under `/admin/api` plus static UI in `src/public/admin/`. Auth
   ([src/http/auth.js](src/http/auth.js)) is an HMAC of the admin
   password stored in the cookie, so changing `ADMIN_PASSWORD` invalidates all
   sessions; `/admin/login` is rate-limited per IP to blunt brute-force. The
   route is HTTP-only orchestration; request validation and
   response view-models are pure functions in the **same file** (formerly
   `admin-domain.js`), kept exported and side-effect-free so
   [test/http/admin-domain.test.js](test/http/admin-domain.test.js) still imports them
   directly.

   The **catalog surface** ([src/http/catalog.js](src/http/catalog.js)) is a
   separate router mounted *inside* `admin.js`'s `/api` sub-router, so it
   inherits the auth, CSRF and JSON-body middleware and adds none of its own. It
   follows the same pure-fn convention (`validateSource`, `validateChannelPatch`,
   `parseChannelQuery`, `personalRowJson`, `isLocked`, … — see
   [test/http/catalog-api.test.js](test/http/catalog-api.test.js)). Channel listings are
   **paged and filtered server-side**; `/api/state` therefore carries only
   headline catalog *counts*, never the channel rows, because a provider list can
   be tens of thousands of entries and that payload loads on every screen.
   Bulk channel edits accept either `{ids}` or `{filter}` — the latter so
   "disable all 4 000 results" doesn't ship 4 000 ids from a paged table.

   **Subscriptions are dated by payment, not by hand.**
   `POST /admin/api/users/:id/payment` takes `{ count, period, from }` — all
   optional, defaulting to one of the plan's own `billing_period` — and pushes
   `expires_at` out by that much, so nobody counts months in their head. Paid
   time **stacks on the existing date** (renewing early never burns the
   remainder); a lapsed or open-ended account starts from today instead, and
   `from: 'today'` forces that. The arithmetic is `addPeriod` in `core/util.js`
   (clamping 31 янв + 1 мес to 28 фев) via the pure `validatePayment` /
   `paymentExpiry` in `admin.js`. It is a separate endpoint rather than part of
   `PATCH /users/:id` so a payment bot can call it with an empty body; the
   manual date field stays for fixing a wrong date.

   Every payment is also written to a **ledger** (`Payments` in `data/store.js`,
   `GET /api/payments`): amount (`amount_eur`, blank = the plan's price for the
   periods paid, `suggestedPaymentCents`), note, previous and new expiry, with
   the customer's name and plan snapshotted so the history survives a rename or
   a deleted customer. `DELETE /api/payments/:id` undoes a mistake by restoring
   the previous date — but **only the customer's latest payment, and only while
   their expiry is still the date it set** (409 otherwise), so an undo can never
   silently revert a later payment or a manual fix. The admin records payments
   in the **Оплаты** section (`pages/PaymentsPage.jsx`), not in the customer
   card; the card links there (`#/payments/<id>` pre-selects the customer).

   **Catalog edits do not regenerate anything** (the `.m3u` is rendered per
   request), which is the main reason this router is separate. Other mutations
   still trigger **fire-and-forget** regeneration: plan, branding and
   **incident** edits regenerate **all** users (expired users render every
   available plan; the status slide is global), while user edits regenerate just
   that user. Incidents (`/admin/api/incidents`, states `degraded`/`outage`)
   drive the status board's 90-day uptime strip.

   The browser UI is a **React + Vite + Ant
   Design** app in [frontend/](frontend/) (its own `package.json`) that builds to
   `src/public/admin/` at Docker build time (Vite `base: '/admin/static/'`); the
   route serves that SPA shell at `/admin` with **no server-side auth gate** (the
   app renders its own login view on a 401 — there is no `login.html`/
   `requireAuthPage`). Mutating `/admin/api` calls must carry an `X-CSRF-Token`
   header (`requireCsrf`); the token is handed to the client in `/api/state`. On a
   bare host checkout with no build, `/admin` shows an "Admin UI not built" stub —
   run the Docker image, or `npm run dev` in `frontend/` (its dev server proxies
   `/admin/api` to the backend).

   The app is a sider-navigated shell (`App.jsx`) with one page per section —
   Обзор / Плейлист / Клиенты / Оплаты / Устройства / Тарифы / Инфоканал / Медиаканал / Уведомления —
   routed off the URL hash (`#/clients`) rather than a router dependency; only
   the first segment picks the section, so `#/clients/<id>` opens that
   customer's drawer (and `#/payments/<id>`, `#/devices/<id>` open those
   sections with the customer picked — `go('payments/12')`). The customer
   drawer deliberately holds **no payment form and no device list**: both are
   managed for everyone in their own section, and the drawer links there.
   Инфоканал and Медиаканал share one layout (`ChannelHeader` → a row of
   stat cards → content cards, the same shape as Устройства) so the two
   built-in channels read as siblings. Mutations that
   *do* re-encode run through the shared `withRegen` banner/reload lifecycle
   (`App.jsx` + `RegenBanner`); the playlist screens deliberately save directly
   instead, since showing an encoding banner for an edit that never encodes
   would be a lie.

   Two UI conventions worth keeping:
   - **Icons come from `@ant-design/icons`, never emoji.** Emoji render as a
     different picture per OS and sit off the text baseline; the icon set is
     vector and themed with the rest of AntD.
   - **Counts go through `count()` in `lib/format.js`.** AntD's `<Statistic>`
     groups its own `value` but leaves `suffix` alone, which is how
     "1,308 / 1310" happened — pass `formatter={count}` *and* build the suffix
     with the same helper.

   The Плейлист section is three tabs: **Каналы и категории** (`CatalogPanel` — a
   category is a row you expand to load that category's channels; typing in the
   search box switches the whole panel to flat, server-filtered results),
   **Источники** and **Доступ** (`GatewayCard` — the stream-gateway switch and
   its HLS coverage; the how-it-works notes sit in a collapsed panel, because
   this screen is for an operator, not a developer). **Устройства** is its own
   sider section (`pages/DevicesPage.jsx`, with a live count badge in the nav):
   a polled view of `GET /api/devices` — who is watching, who was turned away
   by the limit, per-plan limits editable inline, and
   `POST /api/users/:id/devices/reset` to free stale slots. The tracker
   remembers a refused newcomer for the same idle window so the admin can see
   the attempt; it never holds a slot. Opened as `#/devices/<id>` it puts that
   customer's own card (`ClientDevicesCard`) on top.

   The built-in **Информация** category expands like any other but read-only:
   its two channels are listed with no switch, no edit and no selection, and a
   link to the page that manages each (Инфоканал / Медиаканал) — they are this
   server's own channels, not catalog rows to curate.
   Channels are never all in the browser at once — a provider
   list is tens of thousands of rows, so every view is a server-side page.

   Bulk changes are **selection-driven**: tick rows in either table, then act on
   them from the bar above it. Because a page is only 25–50 rows, that bar also
   offers "выбрать все N", which switches the request from `{ids}` to
   `{filter}` — the same server-side path, so switching off a 4 000-channel
   result set never ships 4 000 ids. Category rows deliberately carry *no*
   bulk buttons of their own: acting on channels the row isn't showing is what
   the selection replaces. Expansion is driven by the category name and a
   full-size chevron button (AntD's default 16px +/- glyph was too small to
   aim at), both calling `toggleCategory`.

11. **Media channel** — the second built-in row of Информация
   (`INFO_MEDIA_CHANNEL_ID = 'info-media'`, created by `ensureBuiltins`). Unlike
   the account channel it can be switched off (`applyChannelFields` lets
   `enabled` through for it alone, and per-customer pins apply), but it cannot
   leave Информация, so an expired customer keeps it. Its name and switch live
   on that catalog row — the admin page edits the row, not a copy. The `.m3u`
   (and the admin's visible count) lists it **only once its loop exists** — an
   empty channel is a black screen. Served at `/m/:token/` through the same
   `serveLoopFile`/liveloop path as the account channel.

   **Content = articles.** An article is a TipTap/ProseMirror JSON document
   (the admin's editor, `frontend/src/media/`) with two custom block nodes,
   `mediaImage` / `mediaVideo` `{ assetId, size: full|half|small, caption }`.
   Media is referenced by **asset id, never URL**. `media/doc.js` `sanitizeDoc`
   whitelists exactly the nodes/marks the TV renderer draws (the Markdown set:
   headings 1–3, bold/italic/strike/code, lists, quote, code block, rule,
   tables) — keep the editor's extensions and that whitelist in step.
   Articles + assets live in Settings `media_channel` (left out of
   `publicSettings`); files under `DATA_DIR/media/`. **An asset's file is
   deleted when no article uses it any more**: on save (`Articles.update`),
   with its article (`Articles.remove`, sparing ones pasted into another
   article), or by the sweeps (unsaved uploads and abandoned empty articles
   after 6 h; everything unreferenced at startup).

   **On TV** an article is one clip (`encode/media.js`, comment at the top).
   `render/article.js` lays the page out with satori, **split at each top-level
   video** (`docSections`) because satori reports no positions — rendering the
   pieces separately and stacking them is how the encoder knows exactly where
   each video box sits. `articleTimeline` (pure) then plans: hold, scroll until
   the video (with its caption, `focus`) is centred, **stop while it plays**,
   scroll on, hold. The video is overlaid at `y - scroll(t)` so it moves with
   the page (first frame before, last frame after); music ducks under a video
   with sound. The «1/3 · title» chip counts only non-empty articles, so a
   reorder re-encodes every clip (the number is baked in). Videos are
   re-encoded once at upload into a 720p copy (queue) and the upload deleted;
   a later resolution change re-encodes from that copy (`encodeKey`).

   The **loop** joins the article clips with the concat demuxer — video stream
   copy, audio re-encoded with `aresample=async` (copied AAC overlaps by a few
   ms at every join, since a copy ignores the mp4 edit list). Two invariants
   make the copy valid and keep liveloop's one-discontinuity-per-wrap model:
   **identical encode params on every clip** (`clipEncodeArgs`) and **every
   clip a whole number of segments** (`tileUp`) with keyframes on the
   boundaries; a loop shorter than one live window is repeated
   (`loopRepeats`). Builders are pinned by
   [test/encode/media-args.test.js](test/encode/media-args.test.js) against
   their own golden — same rule as channel-args: never rewrite it silently.
   **satori is loaded lazily through its CommonJS build** — its ESM build
   references `__dirname` and throws on import — which also keeps it off the
   host-run test path (fonts: `MEDIA_FONT_DIR`). Bump `CLIP_VERSION` /
   `LOOP_VERSION` in `media/build.js` when the look or the loop recipe changes.

   **Private content.** An article can be for an **audience** only
   (`article.audience`, `core/audience.js`: customer ids and/or plans; `null` =
   everyone), and any part of an article can be wrapped in a `privateSection`
   block `{ audience }` (the editor's lock button). The TV renderer never sees a
   private section: `filterPrivate` (media/doc.js) resolves the document for one
   viewer first — unwrapped for a member (so a video inside it pauses the
   scroll like any top-level video), removed for everyone else. Customers are
   then grouped into **variants** by what they actually see
   (`media/variants.js`: the visible articles plus which of their sections
   each keeps), and **each variant gets its own loop**: the public one (what a
   customer in no audience sees) at `hls/_media` as before, the others at
   `hls/_media-<hash of the variant key>`. Clips are cached by the resolved
   document, so an article everyone sees alike is still encoded once; «1/3»
   counts per variant. `mediaLoopDirFor(user)` (media/build.js) picks a
   customer's loop for both `/m/:token/` and the `.m3u` listing — and falls back
   to the public loop while theirs is not built yet, which is safe because every
   variant is a **superset** of the public one (private content only adds); a
   customer for whom nothing is visible gets no media channel at all. Because a
   player can move between loops (public → its own, or an old variant → the
   new one after an edit), every new loop's live counters start past the
   **furthest** position of any media loop (`furthestMediaPosition`). With no
   private content anywhere it short-circuits to the public loop. Customer
   changes that can move someone between audiences (create, delete, plan
   change) call `scheduleMediaBuildForClients`, a no-op without private
   content; loops of variants nobody is on any more are swept by the build.
   The preview (`POST /media/preview`) takes `viewer: 'all' | 'public' | <id>`.

## Config

Config is loaded by a **dependency-free `.env` parser** in
[src/config.js](src/config.js) (no `dotenv`); a variable already set in the
environment wins over the `.env` file (so Docker/compose `environment:` values
override it). Every variable is documented, grouped into seven labeled sections,
in [.env.example](.env.example); [docker-compose.yml](docker-compose.yml) mirrors
the same grouping. `config.js` **must stay at `src/`** — its `ROOT` is derived
from its own location and resolves the data dir, music file and `.env` path.

Note that upstream playlist **sources are admin data, not config** — they live in
`catalog.json` and are managed in the UI, including each one's auto-refresh
interval. `config.catalog.*` only bounds *how* they are fetched (timeout, size
cap, the auto-refresh master switch + polling granularity + the interval a new
source starts with) and names the built-in info category.

## Security

The model is deliberate; preserve it when editing.

- **Capability-URL access, no user login.** A customer's whole playlist — and
  with it every provider stream URL in it — is reached only via an
  unguessable nanoid **stream token** in the URL (`/u/:token/...`). The token
  *is* the credential, so the URLs are secrets. Prefer the path form
  `/u/:token/...` over `/playlist.m3u?token=` / `/epg.xml?token=` — query strings
  leak via access logs / `Referer` / proxies — and require TLS off-LAN
  (`PUBLIC_BASE_URL` should be `https://` there).
- **The stream gateway is an access check, not DRM.** With it on the provider
  URL is handed out only at play time and only to an entitled customer — that is
  what makes a revocation effective immediately — but the manifest it returns
  names the provider's segments in clear, so a customer can still read the
  provider addresses behind a channel they legitimately have. Don't document or
  design it as link protection.
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
- **Upstream fetches are bounded.** A playlist source URL must be `http(s)`
  (`validateSource` rejects `file:`/`data:` before it reaches the fetcher) and
  the download has both a timeout and a hard byte cap, so a hostile or broken
  source can't hang the request or exhaust memory.
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
