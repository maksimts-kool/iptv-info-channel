# syntax=docker/dockerfile:1
# Build the admin UI. Node is needed only in this stage.
FROM node:22-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Build the Rust backend with its embedded PostgreSQL migrations.
FROM rust:1.99-bookworm AS backend-build
WORKDIR /app
COPY Cargo.toml Cargo.lock rustfmt.toml clippy.toml ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY tests/ ./tests/
RUN --mount=type=cache,id=iptv-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=iptv-cargo-target,target=/app/target,sharing=locked \
    cargo build --locked --release --jobs 2 \
    && cp target/release/iptv-server /usr/local/bin/iptv-server

# Optional test image: cargo and the source stay out of the runtime image.
FROM backend-build AS test
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-inter \
    && rm -rf /var/lib/apt/lists/*
COPY assets/ ./assets/
COPY --from=frontend /app/public/admin/ ./public/admin/
CMD ["cargo", "test", "--locked"]

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates fonts-inter curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 iptv \
    && useradd --uid 1000 --gid iptv --no-create-home --shell /usr/sbin/nologin iptv
WORKDIR /app
COPY --from=backend-build /usr/local/bin/iptv-server /usr/local/bin/iptv-server
COPY --from=frontend /app/public/admin/ ./public/admin/
COPY assets/ ./assets/
RUN mkdir -p /app/data && chown iptv:iptv /app/data
VOLUME ["/app/data"]
ENV PORT=9222
EXPOSE 9222
USER iptv
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
    CMD curl --fail --silent "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/iptv-server"]
CMD ["serve"]
