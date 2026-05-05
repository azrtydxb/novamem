---
title: Filing bugs
---

# Filing bugs

Open issues at <https://github.com/azrtydxb/novamem/issues/new>. Include:

## Reproduce

```
1. Set up: docker compose up / kubectl apply / npx init …
2. The exact command / curl / dashboard click that triggers the bug.
3. The expected result.
4. The actual result.
```

If reproduction needs data, paste the minimal MCP `memory_remember` payloads (with `force: true` for short tests) that set up the bad state.

## Versions

```bash
# Server
ghcr.io/azrtydxb/novamem:<tag>      # docker
# or
git rev-parse HEAD                   # source

# CLI
npx @azrtydxb/novamem-init --version

# Stdio shim
npx @azrtydxb/novamem-mcp --version

# Node + pnpm
node --version
pnpm --version
```

## Logs

Server (Pino, level info+):

```bash
# Compose
docker compose logs --tail 200 novamem

# k8s
kubectl -n novamem logs deployment/novamem --tail=200
```

Trim to the lines around the failure. Include any error messages verbatim.

## Browser

For dashboard bugs, include:

- Browser + version
- Console errors (DevTools → Console)
- Network response for the failing request (DevTools → Network → click the row → Response)

A 5-second screen recording of the bug is gold; use [`https://www.cleanshot.com/`](https://www.cleanshot.com/) or any screen recorder.

## Security issues

Don't open a public issue. Email <pascal@watteel.com> or use GitHub's Security Advisories. See [SECURITY.md](https://github.com/azrtydxb/novamem/blob/main/SECURITY.md).

## What helps a lot

- A minimal reproduction (smaller is better — a one-line curl beats a 50-step dashboard click trail)
- The `req.id` from the server log (Fastify generates one per request — easy to grep)
- Confirmation of which version it broke / which version it last worked on, if you can pin it down
- A guess at the root cause if you have one — even a wrong guess narrows the search
