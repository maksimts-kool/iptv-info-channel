# ---- Stage 1: build the React + Vite + Ant Design admin UI ----
FROM node:20-bookworm-slim AS frontend
WORKDIR /ui
# No committed lockfile, so `npm install` (not ci). Manifest first for caching.
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
# Emits /ui/dist with base '/admin/static/' (see frontend/vite.config.js).
RUN npm run build

# ---- Stage 2: runtime (Node + ffmpeg) ----
FROM node:20-bookworm-slim

# ffmpeg (video/audio + HLS), tini for clean signal handling, and Inter with
# Cyrillic support for the rendered channel graphics.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates fonts-inter \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Backend deps first (better layer caching). Prod-only — the frontend build deps
# stayed in stage 1 and never reach this image.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source
COPY . .

# Built admin UI from stage 1, served by http/admin.js at /admin + /admin/static.
COPY --from=frontend /ui/dist/ ./src/public/admin/

# Run as the built-in non-root `node` user. Create the data dir and hand /app to
# node so it can write db.json + generated HLS. A bind-mounted ./data must also
# be writable by uid 1000 (node) — `sudo chown -R 1000:1000 ./data` once — while
# a named volume inherits this owner automatically (chown runs before VOLUME).
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=9222
EXPOSE 9222

USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
