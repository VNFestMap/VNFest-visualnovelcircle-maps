# VNFest Go backend image.
# The previous PHP image remains a separately retained rollback artifact during
# the release window; this production Dockerfile intentionally contains no
# PHP, Apache, Composer, or PHP dependency tree.

FROM golang:1.26-bookworm AS build

WORKDIR /src
COPY backend/go.mod backend/go.sum ./backend/
RUN cd /src/backend && go mod download
COPY backend ./backend
COPY . .

RUN cd /src/backend \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/vnfest-server ./cmd/vnfest-server \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/vnfest-worker ./cmd/vnfest-worker \
    && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /out/vnfest-migrate ./cmd/vnfest-migrate

FROM debian:bookworm-slim AS runtime

ENV TZ=Asia/Shanghai \
    BACKEND_ROOT=/app \
    APP_ADDR=:8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /app/uploads /app/wiki/uploads

WORKDIR /app
COPY --from=build /out/vnfest-server /usr/local/bin/vnfest-server
COPY --from=build /out/vnfest-worker /usr/local/bin/vnfest-worker
COPY --from=build /out/vnfest-migrate /usr/local/bin/vnfest-migrate
COPY . /app

# Static HTML/CSS/JS and public assets are served by Go. PHP source is never
# copied into the runtime image; admin/events.php is the one historical URL
# deliberately retained as a static document and is restored after cleanup.
RUN mkdir -p /tmp/vnfest-static \
    && cp /app/admin/events.php /tmp/vnfest-static/events.php \
    && find /app -type f -name '*.php' ! -path '/app/admin/events.php' -delete \
    && rm -rf /app/api /app/includes /app/scripts /app/backend /app/vendor /app/node_modules /app/.github /app/.codex /app/.agents \
    && rm -f /app/config.php /app/config.example.php /app/composer.json /app/composer.lock \
    && mkdir -p /app/admin \
    && cp /tmp/vnfest-static/events.php /app/admin/events.php \
    && rm -rf /tmp/vnfest-static \
    && chown -R 65532:65532 /app /usr/local/bin/vnfest-*

USER 65532:65532
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/api/health.php || exit 1

ENTRYPOINT ["/usr/local/bin/vnfest-server"]
