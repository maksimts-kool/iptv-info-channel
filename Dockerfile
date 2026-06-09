# Node 20 + ffmpeg for HLS generation
FROM node:20-bookworm-slim

# ffmpeg (video/audio + HLS), tini for clean signal handling, and Inter with
# Cyrillic support for the rendered channel graphics.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates fonts-inter \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# App source
COPY . .

# Data dir (db + generated HLS) is a volume
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=9222
EXPOSE 9222

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
