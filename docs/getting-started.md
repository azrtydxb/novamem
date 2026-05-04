# Getting started

Five minutes from zero to a working memory store with an AI tool wired in.

## 1. Run the server

The fastest path is Docker Compose:

```bash
git clone https://github.com/azrtydxb/novamem.git
cd novamem
cp .env.example .env

# Generate secrets
echo "NOVAMEM_COOKIE_SECRET=$(openssl rand -hex 32)" >> .env
echo "NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 12)" >> .env

docker compose up -d
```

Wait \~30s for Postgres + Qdrant + FalkorDB + the embedder to settle, then check:

```bash
curl http://localhost:7778/health
```

Other install paths: [Manual](install/manual.md) · [Kubernetes](install/kubernetes.md).

## 2. Sign in to the dashboard

Open <http://localhost:7778/admin>. Sign in with the admin email + password from your `.env` (default email `admin@example.com`).

From the **Users** tab, create your own non-admin user and sign in as that user. Admins manage users; they don't share user-scope memories.

## 3. Mint a bearer token

In the dashboard, switch to **API Tokens** and click **New token**. Copy the plaintext (`nm_…`) immediately — it's shown once and never again. This bearer carries every right the owning user has: their own memory plus every project they're a member of.

## 4. Connect your AI tool

Pick your host:

- [Claude Code](connect/claude-code.md)
- [Claude Desktop](connect/claude-desktop.md)
- [Cursor](connect/cursor.md)
- [Kilo Code](connect/kilo-code.md)
- [Others + Skills add-on](connect/others-and-skills.md)

Each guide has the exact JSON block. The short version, for any host that speaks remote MCP:

```json
{
  "mcpServers": {
    "novamem": {
      "type": "sse",
      "url": "http://localhost:7778/mcp/sse",
      "headers": { "Authorization": "Bearer nm_..." }
    }
  }
}
```

## 5. Try it from the agent

Ask your AI tool:

> Remember that I prefer pnpm over npm.

It should call `memory_remember`. Then start a fresh session and ask:

> What package manager do I prefer?

It should call `memory_search` and surface the answer.

## What next

- [Usage](usage.md) — search weights, projects (sub-brains), the worthiness gate, decay
- [Architecture](architecture.md) — what's actually happening under the hood
- [API](api/README.md) — full OpenAPI surface for non-MCP clients
- [SECURITY.md](../SECURITY.md) — production hardening checklist before exposing the service beyond localhost
