# IPTV Panel

An IPTV subscription server. You point it at your provider's **m3u playlist
URL**, curate the channel list in a web admin — rename channels, regroup them,
switch categories on and off — and every customer gets their own private `.m3u`
built from that catalog, with **per-customer exceptions** and **automatic
expiry handling**.

Every playlist also carries a built-in **Информация** channel: a personal
looping HLS video channel showing that customer's plan, price, expiry date and
days remaining over background music. When a subscription runs out, that channel
is the *only* thing left in the playlist — so the customer sees exactly why they
lost access and what a renewal costs.

![sample channel card](docs/sample_channel_card.png)

## Features

### Playlist
- **Upstream sources** — add one or more provider `.m3u` URLs; the server downloads, parses and merges them into a single catalog.
- **Curate freely** — rename channels and categories, move a channel to a different category, add channels by hand, and switch anything on or off. Your edits survive the next refresh; only the stream URLs are updated.
- **Nothing is lost** — a channel the provider drops is flagged, not deleted, so a bad download can't destroy your work. It comes back intact when the provider restores it.
- **Built for big lists** — search, filter and bulk enable/disable/regroup work server-side, so a 20 000-channel provider list stays usable.
- **Plans are the packages** — each plan holds the list of categories it sells, and that is exactly what its customers receive. Change a plan and every customer on it changes with it.
- **Per-customer exceptions** — on top of the plan, give one customer a category nobody else has, or take one away, without touching the plan or the catalog.
- **Automatic expiry gate** — an expired or deactivated customer keeps only **Информация**. Renewal restores the full list instantly; there is no state to reset, because visibility is derived on every request.
- **Stream gateway (optional)** — route HLS channels through this server so access is re-checked on **every request** instead of only when the player re-downloads the playlist. A channel you take away stops playing mid-view; a customer who opens one they don't have lands on their own info channel. Only the manifest passes through — the video still flows straight from the provider.

### Info channel
- **Per-customer looping HLS** generated with ffmpeg (h264 + AAC) showing plan, price, expiry, days left and a colour-coded status banner.
- **Expired-account offer slide** — expired customers see the available plans in an automatic 2-, 3- or 4-column grid, each listing the channel categories it includes.
- **Service-status board** — a Better Stack–style global slide with a 90-day uptime strip, driven by incidents you raise in the admin.
- **Branding intro animation**, configurable (`INTRO_*`) or disablable, and **background music** (bundled track or your own).
- **Programme guide** — a per-customer XMLTV guide (plus the OTT-play FOSS JSON format) carrying service and account status.
- **Email notifications** — opt-in expiry warnings, service-status mail and "channels added/removed from your package" notices, plus mandatory renewal notices, over an HTTP email API.

### Operations
- **Web admin** (`/admin`) — playlist, clients, plans, info channel and notifications.
- **Docker** — one container (Node + ffmpeg), data persisted in a volume.
- **Daily job** (00:05) re-downloads the upstream sources and rebuilds the info channels so "days left" stays accurate.

## Quick start (Docker — recommended)

```bash
# 1. configure
cp .env.example .env
#    then edit .env: set ADMIN_PASSWORD, SESSION_SECRET, and PUBLIC_BASE_URL
#    PUBLIC_BASE_URL must be the address your players use, e.g. http://192.168.1.50:9222

# 2. build + run
docker compose up -d --build

# 3. (optional) create demo users
docker compose exec m3u-info npm run seed

# 4. open the admin panel
#    http://<host>:9222/admin   (log in with ADMIN_PASSWORD)
```

> **PUBLIC_BASE_URL matters.** The generated `.m3u` files embed absolute URLs.
> For LAN IPTV boxes set it to the host machine's IP (not `localhost`), e.g.
> `PUBLIC_BASE_URL=http://192.168.1.50:9222`.

### Running the tests

The suite runs inside the same image, so no host toolchain is required:

```bash
docker compose --profile test run --rm test
```

### Without Docker (optional)

Requires **Node 20+** and **ffmpeg** on PATH.

```bash
cp .env.example .env      # edit values
npm install
npm run seed              # optional demo users
npm start                 # http://localhost:9222
npm test                  # run the test suite
```

## How customers use it

Each customer gets a private link from the admin panel:

```
http://<host>:9222/u/<token>/playlist.m3u
```

Add that URL to any IPTV player (TiviMate, IPTV Smarters, VLC, …). The playlist
is built fresh on every request from the catalog, so channel renames, category
toggles and per-customer changes appear as soon as the player refreshes — no
regeneration, no re-issued link.

What it contains, in order:

- the **Информация** channel first (this server's own HLS stream at
  `/hls/<token>/index.m3u8`), then
- the categories their **plan** grants — minus anything withheld from this
  customer personally, plus anything granted only to them.

When the subscription expires — or you deactivate the customer — the same URL
starts returning **only** the Информация channel. Move the expiry date forward
and the full list is back on the next refresh.

### Stream gateway (taking a channel back without a playlist refresh)

By default the `.m3u` carries the **provider's own** stream URLs. That means a
player which downloaded the playlist once talks straight to the provider: this
server never sees the request, so a customer who lost a category keeps watching
it until their player re-downloads the playlist — and many players only do that
when the user asks them to.

Switch the **stream gateway** on (admin → Плейлист → Доступ, or
`STREAM_GATEWAY_ENABLED=true`) and every **HLS** channel is published as

```
http://<host>:9222/c/<token>/<channel id>
```

On every request the server re-resolves that customer's entitlement — the plan,
their personal exceptions, the global switches and the expiry date — and then
fetches the provider's manifest and returns it with each URI inside rewritten to
an absolute provider URL. **No video is proxied**: the player takes the segments
straight from the provider, so only a few kilobytes per refresh pass through
here. Since a player re-fetches a live media playlist every few seconds, a
revoked channel stops **mid-view**, not just at the next channel switch.

- A channel the customer may not watch redirects to **their own info channel**
  (plan, expiry, what's on offer) rather than failing with an error.
- Turning it on takes effect for a customer the first time their player
  re-downloads the playlist; from then on nothing needs refreshing.
- Turning it off puts the provider's URLs back into **new** playlists — the
  `/c/` links already sitting in players keep working.
- **New channels still need a playlist refresh** to appear. The gateway controls
  what plays, not what is listed.
- Catch-up/archive URLs (`catchup-source`) are passed through from the provider
  and are not routed through the gateway.

**Only HLS (`.m3u8`) channels are gated**, and the admin card shows how many of
your channels that is. A raw MPEG-TS stream (`…/live/user/pass/123.ts`, or no
extension at all) has no manifest to rewrite, so the only way to gate it would
be a redirect from this server's `https` to the provider's `http` — and Android
players (ExoPlayer/media3) refuse cross-protocol redirects by default, leaving
the channel buffering forever while a desktop player follows the same redirect
happily. Those channels are therefore published as direct provider URLs and keep
the un-gated behaviour: access to them changes only when the player re-downloads
the playlist.

### Programme guide (EPG)

The `.m3u` advertises a per-user **XMLTV** guide (via `url-tvg`), so players that
show an EPG put the customer's subscription status right in the channel list and
info bar — without them having to tune into the info channel at all:

```
http://<host>:9222/u/<token>/epg.xml
```

Each day is one programme. Its **title** is the short status the player shows
next to the channel:

```
✓ Подписка активна · ещё 89 дней
⚠ Подписка истекает · ещё 4 дня
⚠ Подписка истекает · последний день
✕ Подписка истекла
✕ Аккаунт отключён
```

When an incident covers that day, the service state is prefixed onto the same
line (`⚠ Перебои в работе · Подписка активна · ещё 89 дней`, `✕ Сбой сервиса ·
…`) so an outage can never be hidden by a healthy account — and, equally, a
healthy service never crowds out the status the customer came for.

Opening the programme shows the rest: the expiry date as the sub-title, then the
plan and its price, the full service headline (`✓ Все сервисы работают` / `⚠
Частичная деградация сервиса` / `✕ Сбой в работе сервиса`), 90-day uptime and
any incident notes — driven by the same incidents that power the on-screen
status board. Days-left is sampled per day, so it counts down across the guide.
Disable with `EPG_ENABLED=false`.

#### OTT-play FOSS

OTT-play FOSS does not use the raw XMLTV URL for this channel. When
`EPG_FOSS_ENABLED=true` (the default), the playlist also advertises a static
FOSS JSON source:

```m3u
#EXTM3U ... foss-tvg="=infochannel::http://<host>:9222/foss-epg/u/<token>/epg/"
#EXTINF:-1 tvg-id="account-<token>" tvg-source="=infochannel" ...
```

The leading `=` is required in both places: it takes the channel out of the
central auto-match and loads the guide straight from this server (`tvg-id` is
mandatory in that mode — it is the file name).

**The source URL has to end at the `epg/` directory.** In this static mode
OTT-play appends `<xxhash32(tvg-id)>.json` to the advertised string verbatim,
with no path of its own, so publishing the token base one level up — which this
server did until now — sends the player to a URL that does not exist and the
channel silently shows no programme at all. The documented reference form is
`foss-tvg="=iptvx::http://epg.ottp.eu.org/iptvx.one/epg/"`, matching the real
file at `.../iptvx.one/epg/890122.json`. (The `/m3u/match-channels` protocol is
the exception: its provider block names the level above, and the player adds the
`epg/` itself.)

The channel also includes a `tvg-logo` URL so the player does not make a
separate central logo-match request.

That JSON guide carries the **same text** as the XMLTV one — `name` is the
one-line status above, `descr` the detail block — so a Televizo user and an
OTT-play FOSS user are never told two different things about the same account.

The static source above needs no `channels.json`, but the file is served anyway
for the matcher path, and it carries the binding step that is easy to miss:
`url-hashes`, the hash of the very `url-tvg` this customer's `.m3u` advertises.
A matcher **only applies a provider that declares that hash**, so an empty list
means no guide at all, however correct the rest is. The hash is xxhash32 over
the URL with the `http(s)://` prefix removed, **not** lowercased — while the
channel-id hash in the same file *is* lowercased. Both rules are pinned by tests
against OTT-play's own live providers.

```
GET /foss-epg/u/<token>/channels.json
{"meta":{"id":"infochannel","url-hashes":[4228826628],"last-upd":…,"last-epg":…},
 "data":{"3868628944":["account-<token>¦<last-epg>¦<logo url>","<brand> — <user>"]}}
```

The server additionally exposes compatible fallback endpoints at
`/m3u/match-channels` and `/m3u/match-logos`, plus
`/foss-epg/u/<token>/channels.json`. The channel matcher proxies and merges the
normal OTT-play matcher response, so using it as `!epg-server` preserves EPG for
the other channels in a combined playlist.

## Admin panel

`http://<host>:9222/admin` — sign in with `ADMIN_PASSWORD`. Six sections:

**Обзор** — headline numbers, who is about to expire, current service status.

**Плейлист** — the main screen, two tabs:

- *Каналы и категории* — the catalog as one structure: each category is a row
  you expand (click its name or the chevron) to see and edit the channels inside
  it. Rename a category, reorder it, switch it off; on a channel, rename it,
  move it to another category or toggle it on air. To change many at once, tick
  them and use the bar above the list — включить, выключить or move them to
  another category — with **выбрать все N** to reach the whole category rather
  than just the current page. Typing in the search box switches the panel to
  flat results across the whole catalog, where the same selection works over
  everything matching the filter.
  **Информация** is the built-in category holding the info channel: it can be
  renamed but never deleted or switched off, because it is the fallback an
  expired customer is left with. Imported channels and categories have no delete
  button on purpose — the next source refresh would bring them straight back, so
  switching them off is the control that sticks. Only rows you added by hand can
  be deleted.
- *Источники* — provider playlist URLs. "Обновить" re-downloads and merges one
  source; failures are shown on the row rather than silently swallowed. Each
  source also has its own **Авто-обновление** switch and interval (hourly up to
  weekly, daily by default), so the server keeps the catalog in step with the
  provider by itself; the row shows when the next download is due.

**Клиенты** — the customer list, with a card per customer covering:

- *Аккаунт* — name, plan, expiry, active toggle, their `.m3u` link and link
  re-issue. **Оплата** is where the expiry date normally comes from: enter how
  much was paid for ("1 мес.") and the date is worked out from the plan's
  billing period. Paid time is added on top of what is left, so renewing early
  costs the customer nothing; a lapsed or open-ended account starts from today.
  The date field above stays editable for fixing a wrong date by hand.
- *Каналы клиента* — per-customer access. Every category and channel shows its
  global setting, this customer's pin (**По умолчанию / Включить / Выключить**)
  and the effective result. A pin works both ways: it can withhold a channel
  everyone else has, or grant one that is globally off.
- *Уведомления* — their email subscription and its topics.
- *Плейлист клиента* — the literal `.m3u` their player downloads.

**Тарифы** — a plan **is** the channel package: a name, a price, and the
tick-list of categories its customers receive. That same list is what the info
channel prints as the plan's contents, so a change rebuilds the streams. A plan
with nothing ticked sells nothing — its customers get only Информация — and that
is flagged on the Обзор, Тарифы and Плейлист screens. A plan assigned to
customers can't be deleted until they are moved off it.

**Инфоканал** — branding (service name + tagline), incidents feeding the status
board, and the "rebuild all streams" control.

**Уведомления** — the global email switch, provider health and the send log.

> Playlist edits never trigger an ffmpeg rebuild — the `.m3u` is rendered per
> request. Only plan, branding and incident changes re-encode the info channel,
> and those show the progress banner.

## Background music

The bundled `assets/music/background.mp3` plays by default and is copied into
the Docker image. To use another track, set `MUSIC_FILE` to its path and make
that file available inside the container. Any ffmpeg-readable format works and
is looped to fill the channel. If a configured custom file is missing, the app
falls back to the bundled track.

## Configuration (`.env`)

Every variable is documented and grouped into seven labeled sections in
[.env.example](.env.example) (`docker-compose.yml` mirrors the grouping) — copy
it to `.env` and edit. The most-used settings:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9222` | HTTP port. |
| `PUBLIC_BASE_URL` | `http://localhost:9222` | Address embedded in m3u/HLS URLs. Set to host IP on a LAN. |
| `TZ` | `Europe/Tallinn` | Timezone used for logs, daily refresh scheduling and displayed update dates. |
| `ADMIN_PASSWORD` | `changeme` | Admin panel password. **Change it.** |
| `SESSION_SECRET` | — | Signs the admin cookie. Use a long random string. |
| `TRUST_PROXY` | — | Set to `1` behind a reverse proxy so the login / sign-up rate limiters see real client IPs. |
| `CATALOG_AUTO_REFRESH` | `true` | Master switch for unattended re-downloading. Each source's own interval is set in the admin. |
| `CATALOG_REFRESH_CHECK_MINUTES` | `5` | How often the scheduler looks for a source that has come due (not the refresh interval itself). |
| `CATALOG_REFRESH_INTERVAL_HOURS` | `24` | Refresh interval a newly added source starts with. |
| `CATALOG_FETCH_TIMEOUT_MS` | `30000` | Milliseconds before an upstream playlist download is abandoned. |
| `CATALOG_MAX_BYTES` | `33554432` | Hard cap on a downloaded playlist so a bad URL can not exhaust memory. |
| `INFO_CATEGORY_NAME` | `Информация` | Name of the built-in category holding the info channel (renameable in the admin too). |
| `STREAM_GATEWAY_ENABLED` | `false` | Publish HLS channels as `/c/<token>/<id>` so access is re-checked on every request (the manifest is served back rewritten). The admin toggle overrides this. |
| `STREAM_GATEWAY_TIMEOUT_MS` / `STREAM_GATEWAY_MAX_BYTES` | `10000` / `4194304` | Bounds on fetching a provider manifest. |
| `STREAM_GATEWAY_LOG` | `false` | One log line per gate request, with the player's User-Agent. For diagnosing "this device won't play". |
| `ACCOUNT_SLIDE_SECONDS` | `120` | Seconds the account (info) card is on screen. The loop total is the sum of every enabled slide. |
| `CHANNEL_WIDTH` / `CHANNEL_HEIGHT` | `1920` / `1080` | Output resolution. |
| `CHANNEL_LIVE_LOOP` | `true` | Serve an endless sliding live playlist with no seekable end. |
| `STATUS_SLIDE_ENABLED` / `STATUS_SLIDE_SECONDS` | `true` / `12` | Append the global service-status board slide, and how long it holds. |
| `EXPIRING_THRESHOLD_DAYS` | `7` | Days‑left value at/under which status becomes `EXPIRING SOON`. |
| `EPG_ENABLED` | `true` | Advertise a per‑user XMLTV guide (`/u/<token>/epg.xml`) via `url-tvg`. |
| `EPG_DAYS_AHEAD` / `EPG_DAYS_BEHIND` | `7` / `1` | Calendar days of guide emitted ahead of / behind today. |
| `EPG_FOSS_ENABLED` | `true` | Advertise the token-scoped static OTT-play FOSS JSON guide. |
| `EPG_FOSS_PROVIDER_ID` | `infochannel` | Short source name used by the FOSS playlist attributes. |
| `EPG_FOSS_UPSTREAM_MATCH_URL` | `https://ottp.eu.org` | Normal OTT-play matcher merged into the local fallback response. |
| `INTRO_ENABLED` | `true` | Play the animated brand slide before the details card. `false` = plain still card. |
| `INTRO_SLIDE_SECONDS` | `4` | Seconds the brand slide stays on screen before transitioning. |
| `INTRO_TRANSITION` | `slideleft` | ffmpeg `xfade` transition from the brand slide into the card (`fade`, `wipeleft`, `dissolve`, `smoothleft`, …). |
| `MUSIC_FILE` | `assets/music/background.mp3` | Background track. |
| `DATA_DIR` | `data` | Where the JSON stores + generated HLS live (the Docker volume). |

## Data & storage

State is kept in two JSON files, plus the generated streams:

| Path | Holds |
|---|---|
| `DATA_DIR/db.json` | customers, plans, incidents, subscribers, settings |
| `DATA_DIR/catalog.json` | playlist sources, categories, channels, per-customer access |
| `DATA_DIR/hls/<userId>/` | that customer's generated info-channel segments |

The catalog is a separate file on purpose: a provider list can be tens of
thousands of channels, and both stores rewrite the whole file on every save —
keeping them apart means changing one customer's expiry date doesn't rewrite
megabytes of channel rows. Both use atomic writes and back up a corrupt file
rather than failing to start. In Docker this is the mounted `./data` volume, so
everything survives restarts and rebuilds. No external database required.

## Runtime logs

Container output includes concise timestamped details for:

- startup URL and core channel configuration;
- each stream generation start, completion time and failures;
- admin changes that trigger rebuilds;
- scheduler registration and daily refreshes;
- warnings and errors.

Routine HLS segment requests are intentionally not logged. Follow the running
output with:

```bash
docker compose logs -f m3u-info
```

## How it works

**The playlist** (no ffmpeg involved):

1. A source refresh downloads the provider `.m3u`, parses it (attribute-aware —
   a comma inside `tvg-name` doesn't break the channel title) and **merges** it
   into the catalog. Channels are matched on `tvg-id` where the provider ships
   one, falling back to the stream URL, so a rotated access token doesn't create
   duplicates. Your renames, category moves and toggles are preserved; the URL
   and playback directives (`#EXTVLCOPT`, `#KODIPROP`, …) are refreshed.
2. A request for `/u/<token>/playlist.m3u` resolves that customer's view of the
   catalog and serializes it. Categories pass through three layers, highest
   priority first: a **personal pin** (the admin's explicit exception for this
   customer), the **global enable** (the catalog-wide kill switch), then the
   **plan** (what they are paying for). The expiry gate overrules all three.
   Nothing is cached and nothing is pre-built, so an edit is live on the
   player's next refresh.

**The info channel** (ffmpeg, per customer):

3. Two 1280×720 frames are rendered (SVG → PNG via sharp): the **brand intro
   slide** and the **info card**, plus the global **status board** when enabled.
4. **ffmpeg** builds the loop: brand slide → (`xfade` transition) → the info card
   held for `ACCOUNT_SLIDE_SECONDS` → the status board, mixes in the background
   music, and writes reusable **HLS** segments. With the intro disabled it just
   loops the still card. A content hash skips the encode when nothing changed,
   so idle CPU use stays near zero.
5. The server presents those segments as a sliding **live HLS** window with no
   end marker, so IPTV clients keep playing indefinitely. All viewers share one
   live timeline — tuning in joins the stream wherever it currently is, it does
   not restart at the intro.
6. A **daily job** (00:05) re-downloads every enabled source and rebuilds every
   stream, so both the channel list and the day counter stay current.

## API (admin, cookie‑authenticated)

Mutating calls also require an `X-CSRF-Token` header echoing the token handed
out by `/admin/api/state`.

| Method | Path | Action |
|---|---|---|
| `POST` | `/admin/login` | `{password}` → sets session cookie |
| `GET` | `/admin/api/state` | plans, customers (decorated), settings, catalog counts |
| `POST` | `/admin/api/users` | create customer |
| `PATCH` | `/admin/api/users/:id` | update username / plan / `expires_at` / active |
| `POST` | `/admin/api/users/:id/token` | regenerate access token |
| `POST` | `/admin/api/users/:id/regenerate` | rebuild this customer's stream now |
| `GET` | `/admin/api/users/:id/playlist` | the exact `.m3u` this customer receives |
| `DELETE` | `/admin/api/users/:id` | delete customer (drops their overrides too) |
| `GET` | `/admin/api/catalog` | sources, categories with counts, totals |
| `POST` | `/admin/api/catalog/sources` | add a provider playlist `{name, url}` |
| `PATCH`/`DELETE` | `/admin/api/catalog/sources/:id` | edit / remove a source |
| `POST` | `/admin/api/catalog/sources/:id/refresh` | download + merge one source |
| `POST` | `/admin/api/catalog/refresh` | download + merge every enabled source |
| `POST` | `/admin/api/catalog/categories` | create a custom category |
| `PATCH`/`DELETE` | `/admin/api/catalog/categories/:id` | rename / toggle / delete |
| `POST` | `/admin/api/catalog/categories/reorder` | `{ids[]}` → new display order |
| `GET` | `/admin/api/catalog/channels` | paged + filtered (`q`, `category`, `source`, `status`, `page`, `pageSize`) |
| `POST` | `/admin/api/catalog/channels` | add a channel by hand |
| `PATCH`/`DELETE` | `/admin/api/catalog/channels/:id` | rename / re-group / toggle / delete |
| `POST` | `/admin/api/catalog/channels/bulk` | bulk change over `{ids[]}` **or** `{filter}` |
| `GET` | `/admin/api/users/:id/channels` | this customer's effective access view |
| `PATCH` | `/admin/api/users/:id/channels` | pin overrides (`true` / `false` / `null` = inherit) |
| `POST` | `/admin/api/users/:id/channels/reset` | drop all their overrides |
| `POST` | `/admin/api/plans` | Create with `{name, price_eur, category_ids[]}` |
| `PATCH` | `/admin/api/plans/:id` | Update `{name, price_eur, category_ids[]}` |
| `DELETE` | `/admin/api/plans/:id` | Delete an unused plan |
| `PATCH` | `/admin/api/settings` | `{brand_name, tagline}` |
| `PATCH` | `/admin/api/gateway` | `{enabled}` — stream gateway on/off (no regeneration) |
| `POST` | `/admin/api/regenerate-all` | rebuild all streams |

## Security

- **Access is a capability URL.** A channel is reachable only via the
  unguessable per-user token in its path — the token *is* the credential, so
  treat the URLs as secrets. Prefer `/u/<token>/playlist.m3u` over the `?token=`
  query form (query strings leak via access logs / `Referer`), and put the
  server behind **HTTPS** when exposing it off-LAN (`PUBLIC_BASE_URL=https://…`).
- **The stream gateway is an access check, not DRM.** With it on, the provider's
  URL is only handed out at play time and only to a customer entitled to it,
  which is what makes a revocation take effect immediately — but the manifest it
  returns contains the provider's segment URLs in clear, so a customer can still
  read the provider addresses behind a channel they legitimately have.
- The e-mail sign-up QR uses a **separate token**, so photographing it can't
  grant stream access, and sign-up is **double opt-in** (no mail is sent to an
  unconfirmed address).
- The admin session is an HMAC-signed HttpOnly cookie; rotating `ADMIN_PASSWORD`
  logs everyone out. `/admin/login` and the `/sub` endpoints are rate-limited —
  set `TRUST_PROXY=1` behind a reverse proxy so the limiter sees real client IPs.
  Mutating admin API calls also require a CSRF token (`X-CSRF-Token`).
- The container runs as the **non-root `node`** user; if you bind-mount `./data`,
  make it writable by uid 1000 (`sudo chown -R 1000:1000 ./data`) or use a named volume.

## Development

Backend source is grouped by concern under `src/`: `playlist/` (m3u parsing +
the channel catalog), `render/` (SVG frames), `encode/` (ffmpeg + live HLS),
`http/` (all routes), `epg/` (guides), `data/` (the JSON store + its seed CLI),
`notify/` (e-mail) and `core/` (logger + formatters). Only `server.js` (the entry
point) and `config.js` sit loose at `src/`; `test/` mirrors the same folders.
There is no backend build step; run the tests with `docker compose --profile test
run --rm test` (or `npm test` on a host with Node 20+). See
[CLAUDE.md](CLAUDE.md) for the full module map.

The admin UI is a **React + Vite + Ant Design** app in `frontend/` (its own
`package.json`). The Docker build compiles it and copies the output into
`src/public/admin/`, which the server serves at `/admin` — so production needs no
host toolchain. For UI development run `npm install && npm run dev` in `frontend/`
(its dev server proxies `/admin/api` to a backend on `:9222`). On a bare host
checkout with no build, `/admin` shows an "Admin UI not built" stub.

## Notes

- The generated media is reused as an endless live channel, so ffmpeg does not
  need to run continuously. Set `CHANNEL_LIVE_LOOP=false` only to expose the
  finite generated VOD directly.
