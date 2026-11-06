# Static Go server. Build context is the REPO ROOT: the OpenAPI document
# is generated from Go source (internal/httpapi/openapi.go) rather than
# embedded from a TypeScript artefact, and the binary embeds the admin
# dashboard SPA, which is built here and synced into the module by
# go/scripts/sync-admin-ui.sh before `go build` runs.

# ─── Admin dashboard (packages/admin-ui → dist/) ─────────────────────
# Cross-build: every stage that runs commands is pinned to $BUILDPLATFORM, so an arm64
# image is produced without emulation. The final stage has no RUN.
FROM --platform=$BUILDPLATFORM node:26-bookworm AS ui
WORKDIR /repo
RUN npm install -g corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/admin-ui/package.json packages/admin-ui/
RUN pnpm install --filter @azrtydxb/novamem-admin-ui --frozen-lockfile
COPY packages/admin-ui packages/admin-ui
RUN pnpm --filter @azrtydxb/novamem-admin-ui build

FROM --platform=$BUILDPLATFORM golang:1.26-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src/go
COPY go/go.mod go/go.sum ./
RUN go mod download
COPY go/ ./
COPY --from=ui /repo/packages/admin-ui/dist /src/packages/admin-ui/dist
RUN ./scripts/sync-admin-ui.sh
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /novamem-server ./cmd/novamem-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /novamem-server /novamem-server
USER nonroot:nonroot
EXPOSE 7778
ENTRYPOINT ["/novamem-server"]
