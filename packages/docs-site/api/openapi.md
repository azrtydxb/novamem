---
title: OpenAPI spec
---

# OpenAPI spec

novamem's HTTP surface is fully described by an OpenAPI 3.0 document, generated from the same Zod schemas that validate requests at runtime.

## Browse interactively

Every running deployment exposes Swagger UI at:

```
GET  /api-docs
```

Try requests with a real bearer token. The "Authorize" button accepts both `nm_…` (user API token) and `ns_…` (session) bearers.

## Machine-readable

| Source                | URL                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Live (any deployment) | `/openapi.json`                                                                                |
| Static (this repo)    | [`docs/api/openapi.json`](https://github.com/azrtydxb/novamem/blob/main/docs/api/openapi.json) |

## Generate clients

The TypeScript client at [`@azrtydxb/novamem`](https://www.npmjs.com/package/@azrtydxb/novamem) is hand-written for ergonomics. For other languages, generate from the OpenAPI spec:

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
