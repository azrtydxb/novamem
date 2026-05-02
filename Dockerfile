FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/mcp/package.json packages/mcp/
COPY packages/admin-ui/package.json packages/admin-ui/
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
COPY . .
RUN pnpm -r build

FROM node:20-slim AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# P1-O2: ship only the built artifacts + production dependencies. The
# previous image baked dev tools (tsx, vitest, @types/*) and `src/*.ts`
# into the runtime — bigger image, broader attack surface.
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml* ./
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/client/package.json ./packages/client/package.json
COPY --from=build /app/packages/client/dist ./packages/client/dist
COPY --from=build /app/packages/mcp/package.json ./packages/mcp/package.json
COPY --from=build /app/packages/mcp/dist ./packages/mcp/dist
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# P2-15: declare a HEALTHCHECK so orchestrators (Docker Swarm, plain Docker,
# K8s livenessProbe via `exec`) can use the stack-aware /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7778/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# P1-O1: drop privileges. The `node` user ships in the upstream node:20-slim
# image with uid/gid 1000:1000 — adjust to taste. Container-escape blast
# radius is significantly smaller as a non-root process.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 7778
CMD ["node", "packages/server/dist/main.js"]
