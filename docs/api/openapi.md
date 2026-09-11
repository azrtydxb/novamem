---
title: OpenAPI spec
---

# OpenAPI spec

novamem's own HTTP surface is described by an OpenAPI 3.0 document, generated from the Go server's own route table. Better Auth's own routes under `/api/auth/*` are deliberately outside it — they are that library's contract, not novamem's, and documenting a copy of them here would be one more thing to drift.

## Browse interactively

Every running deployment serves a rendered reference at:

```
GET  /api-docs
```

It reads that deployment's own `/openapi.json`, so it describes the server you
are pointed at. Requests you fire from the page are your browser's own, with
whatever bearer you supply — `nm_…` (user API token) or a Better Auth session.

The same renderer, against the spec on `main`, is on this site:
[interactive reference](./reference.md).

## Machine-readable

| Source                | URL                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Live (any deployment) | `/openapi.json`                                                                                |
| Static (this repo)    | [`docs/api/openapi.json`](https://github.com/azrtydxb/novamem/blob/main/docs/api/openapi.json) |

## Generate clients

The Go client at [`clients/go`](https://github.com/azrtydxb/novamem/tree/main/clients/go) is hand-written for ergonomics. For other languages, generate from the OpenAPI spec:

```bash
# Python (openapi-python-client)
openapi-python-client generate \
  --url https://novamem.example.com/openapi.json

# Go (oapi-codegen)
oapi-codegen -package nova \
  https://novamem.example.com/openapi.json > nova.go

# OpenAPI Generator (any language)
openapi-generator-cli generate \
  -i https://novamem.example.com/openapi.json \
  -g rust -o ./novamem-rs
```

## Versioning

The spec is versioned with the server. `/v1/*` routes are stable. Breaking changes go to `/v2/*`. The `info.version` in the spec matches the server's `package.json` version.
