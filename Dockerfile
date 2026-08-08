FROM node:25-bookworm-slim AS base
# node:25-bookworm-slim no longer ships corepack (it was unbundled
# starting with Node 25). Install it from npm before activating pnpm.
# `--force` because the base image has yarn shims at /usr/local/bin/yarnpkg
# that corepack also wants to write — without --force npm bails on EEXIST.
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
# Generate a runtime package.json with devDependencies stripped — keeps
# `dependencies` only so npm in the runtime stage doesn't choke on
# `workspace:*` URL schemes it doesn't understand. Writing to a fresh
# path so we don't mutate the source tree.
# Generate a runtime package.json: drop devDependencies + scripts, and
# inject npm `overrides` for transitive deps with known HIGH/CRITICAL CVEs
# (the pnpm.overrides at workspace root don't carry to a fresh npm install
# in the runtime stage, because npm doesn't read them).
#
# The override list is DERIVED from the root package.json's
# `pnpm.overrides` rather than hand-maintained here. Keeping two parallel
# lists meant the image silently drifted from the workspace every time an
# advisory was fixed in one place and not the other. pnpm's selector
# syntax ("pkg@<1.2.3") is translated to npm's plain form ("pkg"), and a
# couple of runtime-only entries are merged on top.
RUN node ./scripts/gen-runtime-package.mjs ./package.json ./packages/server/package.json /tmp/runtime-package.json

FROM node:25-bookworm-slim AS runtime

# Keep the runtime image patched even when the upstream Node image lags
# behind Debian security updates. Trivy gates HIGH/CRITICAL OS CVEs in CI.
RUN apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ship only the server's compiled JS + a *fresh* prod-only node_modules
# resolved from the server's own dependencies (not the shared workspace
# lockfile, which would otherwise drag in dev tooling like esbuild/vite/
# vitest). Smaller image, smaller attack surface.
COPY --from=build /tmp/runtime-package.json ./package.json
COPY --from=build /app/packages/server/dist ./dist
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
