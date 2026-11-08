# Multi-stage build: web bundle + static Go binary in a distroless image.
# Multi-arch (linux/amd64, linux/arm64): the web bundle and the Go cross-compile run on the build host,
# only the final distroless layer is per-architecture, so no emulation is needed.
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
WORKDIR /w
RUN corepack enable
# the repository is one pnpm workspace with one lockfile: install only what the web client needs
# (corepack runs the pnpm that packageManager in the root package.json pins)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter homequarters-web
COPY web/ web/
WORKDIR /w/web
RUN pnpm build

FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine AS server
ARG TARGETOS=linux
ARG TARGETARCH
# each module builds from its own go.mod only, whatever go.work a build context might carry
ENV GOWORK=off
WORKDIR /s
# one Go module per library (decision 0041): the command's go.mod and go.sum, and the go.mod of each library
# its go.mod replaces with a folder, so that the download layer stays cached until a dependency changes
# (scripts/gauntlet.test.ts checks this list against server/cmd/homequarters/go.mod)
COPY server/cmd/homequarters/go.mod server/cmd/homequarters/go.sum cmd/homequarters/
COPY server/internal/auth/go.mod internal/auth/
COPY server/internal/config/go.mod internal/config/
COPY server/internal/gamemap/go.mod internal/gamemap/
COPY server/internal/httpapi/go.mod internal/httpapi/
COPY server/internal/media/go.mod internal/media/
COPY server/internal/plugin/go.mod internal/plugin/
COPY server/internal/store/go.mod internal/store/
COPY server/internal/testbed/go.mod internal/testbed/
COPY server/internal/world/go.mod internal/world/
WORKDIR /s/cmd/homequarters
RUN go mod download
COPY server/ /s/
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/homequarters . \
 && mkdir /data

FROM gcr.io/distroless/static-debian13:nonroot
# The deploy's commit: clients loaded from another version are asked to reload. Without it the server
# uses a hash of the built page, which also changes with every client build.
ARG HQ_VERSION=
COPY --from=server /out/homequarters /app/homequarters
COPY --from=web /w/web/dist /app/web
# the bundled plugins (hq-*), off until an administrator enables them; an operator's own plugins go in
# /app/plugins/installed, usually a volume mounted there (docs/plugins.md)
COPY plugins/bundled/ /app/plugins/bundled/
COPY --from=server --chown=65532:65532 /data /data
ENV HQ_STATIC_DIR=/app/web HQ_PLUGINS_DIR=/app/plugins HQ_DB=/data/homequarters.db HQ_ADDR=:8080 HQ_VERSION=$HQ_VERSION
VOLUME /data
EXPOSE 8080
# the distroless image's nonroot user, by number so that the host (and Kubernetes' runAsNonRoot) can check it
USER 65532:65532
ENTRYPOINT ["/app/homequarters"]
