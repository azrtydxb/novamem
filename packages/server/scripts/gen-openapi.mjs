import { openapiSpec } from "../dist/openapi.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
const out = resolve(here, "..", "..", "..", "docs", "api", "openapi.json");
writeFileSync(out, JSON.stringify(openapiSpec(), null, 2) + "\n");
console.log("wrote", out);
