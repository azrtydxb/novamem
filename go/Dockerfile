# Static Go server. Build context is the REPO ROOT: the binary embeds
# both the frozen openapi.json (checked in under go/internal/httpapi/,
# kept in sync by packages/server's docs:api generator + the CI drift
# gate) and the admin dashboard SPA, which is built here and synced into
# the module by go/scripts/sync-admin-ui.sh before `go build` runs.

# ─── Admin dashboard (packages/admin-ui → dist/) ─────────────────────
FROM node:22-bookworm AS ui
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/admin-ui/package.json packages/admin-ui/
RUN pnpm install --filter @azrtydxb/novamem-admin-ui --frozen-lockfile
COPY packages/admin-ui packages/admin-ui
RUN pnpm --filter @azrtydxb/novamem-admin-ui build

FROM golang:1.24-bookworm AS build
WORKDIR /src/go
COPY go/go.mod go/go.sum ./
RUN go mod download
COPY go/ ./
COPY --from=ui /repo/packages/admin-ui/dist /src/packages/admin-ui/dist
RUN ./scripts/sync-admin-ui.sh
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /novamem-server ./cmd/novamem-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /novamem-server /novamem-server
EXPOSE 7778
ENTRYPOINT ["/novamem-server"]
