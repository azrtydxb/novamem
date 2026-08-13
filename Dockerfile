# Base image is DIGEST-pinned, not just tag-pinned.
#
# `node:24-bookworm-slim` is a moving tag: it resolves to a different
# image over time, so the Trivy gate could go from green to red with no
# commit to this repo — which is exactly what happened before this pin
# (the scan passed in June and failed in August on an unchanged
# Dockerfile). Pinning the digest makes base-image updates an explicit,
# reviewable change instead of a surprise. Refresh it deliberately when
# picking up upstream security fixes.
#
# Node 24 rather than 25: 24 is the LTS line, it is what release.yml
# publishes from, and it is now covered by the CI test matrix. The image
# previously ran the non-LTS 25 line while CI tested only Node 20.
FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS base
# Install corepack from npm before activating pnpm. `--force` because the
# base image has yarn shims at /usr/local/bin/yarnpkg that corepack also
# wants to write — without --force npm bails on EEXIST.
RUN npm install -g --force corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/mcp/package.json packages/mcp/
COPY packages/admin-ui/package.json packages/admin-ui/
COPY packages/init/package.json packages/init/
COPY packages/benchmarks/package.json packages/benchmarks/
# docs-site is a workspace member — we need its package.json present so
# pnpm install sees a consistent workspace, but we'll skip building it
# in the build stage below. The Pages workflow builds it separately.
COPY packages/docs-site/package.json packages/docs-site/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Skip docs-site and benchmarks — neither is part of the server runtime.
# Docs are built by Pages; benchmarks are an external harness that runs
# against a deployed/local NovaMem service, not inside the production image.
RUN pnpm -r \
  --filter '!@azrtydxb/novamem-docs-site' \
  --filter '!@azrtydxb/novamem-benchmarks' \
  build
# Generate the runtime package.json. Three jobs, all of them about making
# the image match what CI actually tested (see the script for detail):
#
#   1. Drop devDependencies + scripts, so npm never sees `workspace:*`
#      specifiers it can't resolve. Written to a fresh path so the source
#      tree isn't mutated.
#   2. PIN every direct dependency to the version the pnpm lockfile
#      resolved. Without this the runtime `npm install` re-resolves ranges
#      against the registry, and the image can ship different versions
#      from the ones under test — which is how a qdrant client that had
#      removed the method cold-store calls nearly reached production.
#   3. Translate the root `pnpm.overrides` CVE floors into npm's
#      `overrides` field, since npm doesn't read pnpm's. Deriving them
#      beats a hand-maintained second list, which had already drifted.
RUN node ./scripts/gen-runtime-package.mjs ./package.json ./packages/server/package.json /tmp/runtime-package.json

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime

# Keep the runtime image patched even when the upstream Node image lags
# behind Debian security updates. Trivy gates HIGH/CRITICAL OS CVEs in CI.
RUN apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ship only the server's compiled JS + a prod-only node_modules resolved
# from the server's own (now version-pinned) dependencies. Installing
# with npm here rather than reusing the whole pnpm store keeps dev
# tooling — esbuild/vite/vitest and better-auth's optional peers — out of
# the image; `pnpm deploy --prod` was measured at +88MB and +174 packages
# for the same application. Smaller image, smaller attack surface.
COPY --from=build /tmp/runtime-package.json ./package.json
COPY --from=build /app/packages/server/dist ./dist
# Operator tooling (e.g. sync-qdrant-to-pgvector.mjs for backend
# migration). Plain .mjs, no build step, runs against the installed
# node_modules — shipping it means a migration is `kubectl exec node
# /app/scripts/...` instead of hand-copying a script into the pod.
COPY --from=build /app/packages/server/scripts ./scripts
# Keep --omit=dev but NOT --omit=optional. `onnxruntime-node` ships as an
# optionalDependency of `@xenova/transformers` (its native binary varies
# per platform); stripping optional deps breaks the local-transformers
# embedder at runtime with ERR_MODULE_NOT_FOUND on every embed call.
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock \
 && npm cache clean --force \
 # Strip the TypeScript compiler from the runtime tree.
 #
 # `@qdrant/js-client-rest` declares `typescript: ">=4.7"` as a
 # NON-optional peerDependency, and npm 7+ auto-installs those. TypeScript
 # 7 is written in Go and ships a ~27MB native binary
 # (@typescript/typescript-<platform>), so a production image that never
 # compiles anything was carrying a Go toolchain — along with its Go
 # stdlib and golang.org/x/text CVEs, which Trivy (correctly) fails on and
 # which no npm-level override can fix, because they live inside a
 # compiled binary.
 #
 # Nothing imports typescript at runtime: it is a types-only peer, and the
 # qdrant client's dist never requires it. Verified by loading the client
 # with the compiler removed.
 && rm -rf node_modules/typescript node_modules/@typescript \
 # Drop the global npm tree once install is done — we run plain `node` at
 # runtime, not npm. Keeps Trivy from flagging CVEs in npm's own bundled
 # deps (picomatch, etc.) that aren't part of our application.
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Stack-aware healthcheck against the server's /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7778/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Drop privileges. `node` ships uid/gid 1000:1000 in the base image.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 7778
CMD ["node", "dist/main.js"]
