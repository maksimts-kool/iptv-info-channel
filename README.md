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

### Info channel
- **Per-customer looping HLS** generated with ffmpeg (h264 + AAC) showing plan, price, expiry, days left and a colour-coded status banner.
- **Expired-account offer slide** — expired customers see the available plans in an automatic 2-, 3- or 4-column grid, each listing the channel categories it includes.
- **Service-status board** — a Better Stack–style global slide with a 90-day uptime strip, driven by incidents you raise in the admin.
- **Branding intro animation**, configurable (`INTRO_*`) or disablable, and **background music** (bundled track or your own).
- **Programme guide** — a per-customer XMLTV guide (plus the OTT-play FOSS JSON format) carrying service and account status.
- **Email notifications** — opt-in expiry warnings and service-status mail, plus mandatory renewal notices, over an HTTP email API.

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

### Programme guide (EPG)

The `.m3u` advertises a per-user **XMLTV** guide (via `url-tvg`), so players that
show an EPG display the current service status right in the channel list and
info bar:

```
http://<host>:9222/u/<token>/epg.xml
```

Each day is one programme whose title is the service status — `✓ Все сервисы
работают`, `⚠ Частичная деградация сервиса`, or `✕ Сбой в работе сервиса` —
driven by the same incidents that power the on-screen status board. The
description also carries the account's subscription status (days left) and any
incident notes. Disable with `EPG_ENABLED=false`.

#### OTT-play FOSS

OTT-play FOSS does not use the raw XMLTV URL for this channel. When
`EPG_FOSS_ENABLED=true` (the default), the playlist also advertises a static
FOSS JSON source:

```m3u
#EXTM3U ... foss-tvg="=infochannel::http://<host>:9222/foss-epg/u/<token>/"
#EXTINF:-1 tvg-id="account-<token>" tvg-source="=infochannel" ...
```

The leading `=` is required in both places. It makes OTT-play fetch
`epg/<xxhash32(tvg-id)>.json` directly from the token-scoped base, bypassing
the central match service. The channel also includes a `tvg-logo` URL so the
player does not make a separate central logo-match request.

The server additionally exposes compatible fallback endpoints at
`/m3u/match-channels` and `/m3u/match-logos`, plus
`/foss-epg/u/<token>/channels.json`. The channel matcher proxies and merges the
normal OTT-play matcher response, so using it as `!epg-server` preserves EPG for
the other channels in a combined playlist.

## Admin panel

`http://<host>:9222/admin` — sign in with `ADMIN_PASSWORD`. Six sections:

**Обзор** — headline numbers, who is about to expire, current service status.

**Плейлист** — the main screen, three tabs:

- *Каналы* — the whole catalog with search, category/source/status filters and
  paging. Rename a channel, change its category, toggle it on air, add one by
  hand, or select rows (or the entire filtered set) for a bulk change.
- *Категории* — rename, reorder, enable/disable, create your own, delete.
  **Информация** is the built-in category holding the info channel: it can be
  renamed but never deleted or switched off, because it is the fallback an
  expired customer is left with.
- *Источники* — provider playlist URLs. "Обновить" re-downloads and merges one
  source; failures are shown on the row rather than silently swallowed.

**Клиенты** — the customer list, with a card per customer covering:

- *Аккаунт* — name, plan, expiry, active toggle, their `.m3u`/HLS links, link
  re-issue, manual info-channel rebuild.
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
is flagged on the Обзор, Тарифы and Категории screens. A plan assigned to
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
| `CATALOG_AUTO_REFRESH` | `true` | Re-download every enabled upstream source in the daily 00:05 job. |
| `CATALOG_FETCH_TIMEOUT_MS` | `30000` | Milliseconds before an upstream playlist download is abandoned. |
| `CATALOG_MAX_BYTES` | `33554432` | Hard cap on a downloaded playlist so a bad URL can not exhaust memory. |
| `INFO_CATEGORY_NAME` | `Информация` | Name of the built-in category holding the info channel (renameable in the admin too). |
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
| `POST` | `/admin/api/regenerate-all` | rebuild all streams |

## Security

- **Access is a capability URL.** A channel is reachable only via the
  unguessable per-user token in its path — the token *is* the credential, so
  treat the URLs as secrets. Prefer `/u/<token>/playlist.m3u` over the `?token=`
  query form (query strings leak via access logs / `Referer`), and put the
  server behind **HTTPS** when exposing it off-LAN (`PUBLIC_BASE_URL=https://…`).
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
`http/` (all routes), `epg/` (guides), with
`config.js`, `data.js`, `util.js`, `logger.js` and `notify.js` at the root. There
is no backend build step; run the tests with `docker compose --profile test run
--rm test` (or `npm test` on a host with Node 20+). See [CLAUDE.md](CLAUDE.md) for
the full module map.

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
