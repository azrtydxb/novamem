FROM node:26-bookworm-slim AS base
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
# in the runtime stage). Versions chosen from Trivy's fixed-version field.
RUN node -e "const p=require('./packages/server/package.json');delete p.devDependencies;delete p.scripts;p.overrides={protobufjs:'>=7.5.5',picomatch:'>=4.0.4',underscore:'>=1.13.8'};require('fs').writeFileSync('/tmp/runtime-package.json',JSON.stringify(p,null,2));"

FROM node:26-bookworm-slim AS runtime

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
