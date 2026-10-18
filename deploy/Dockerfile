# Multi-stage build: web bundle + static Go binary in a distroless image.
# Multi-arch (linux/amd64, linux/arm64): the web bundle and the Go cross-compile run on the build host,
# only the final distroless layer is per-architecture, so no emulation is needed.
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /w
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS server
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /s
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/homequarters ./cmd/homequarters \
 && mkdir /data

FROM gcr.io/distroless/static-debian12:nonroot
# The deploy's commit: clients loaded from another version are asked to reload. Without it the server
# uses a hash of the built page, which also changes with every client build.
ARG HQ_VERSION=
COPY --from=server /out/homequarters /app/homequarters
COPY --from=web /w/dist /app/web
# operator-installed plugins (docs/plugins.md); off until an administrator enables them
COPY plugins/ /app/plugins/
COPY --from=server --chown=65532:65532 /data /data
ENV HQ_STATIC_DIR=/app/web HQ_PLUGINS_DIR=/app/plugins HQ_DB=/data/homequarters.db HQ_ADDR=:8080 HQ_VERSION=$HQ_VERSION
VOLUME /data
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/app/homequarters"]
