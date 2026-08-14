// Regenerate reference/tools.snapshot.json from the live oracle.
// Usage: NOVAMEM_URL=... NOVAMEM_TEST_TOKEN=... node scripts/snapshot-tools.mjs
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.NOVAMEM_URL?.replace(/\/$/, "");
const token = process.env.NOVAMEM_TEST_TOKEN;
if (!url || !token) throw new Error("NOVAMEM_URL and NOVAMEM_TEST_TOKEN are required");

const client = new Client({ name: "novamem-conformance-snapshot", version: "0.0.1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const schemas = Object.fromEntries(
  [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, t.inputSchema]),
);
writeFileSync(new URL("../reference/tools.snapshot.json", import.meta.url),
  JSON.stringify({ names, schemas }, null, 2) + "\n");
console.log(`snapshot: ${names.length} tools`);
await client.close();
