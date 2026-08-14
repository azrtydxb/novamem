# Static Go server. Build context is the REPO ROOT (the embed copy of
# openapi.json is checked in under go/internal/httpapi/, kept in sync by
# packages/server's docs:api generator + the CI drift gate).
FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go/go.mod go/go.sum ./
RUN go mod download
COPY go/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /novamem-server ./cmd/novamem-server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /novamem-server /novamem-server
EXPOSE 7778
ENTRYPOINT ["/novamem-server"]
