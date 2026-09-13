import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The dashboard's types must not invent server fields.
 *
 *  Three times in one week a hand-written interface in api.ts declared a
 *  field the server has never sent, and each time a page trusted the type
 *  and shipped a lie to the user:
 *
 *    - `RecentEntry.signals` — /v1/recent computes no ranking, so
 *      expanding a Browse row passed `undefined` into KSignals and threw.
 *    - `RecentEntry.hits` — GraphPage sized nodes by it and the inspector
 *      displayed a confident "0" for a number nobody returns.
 *    - `OnboardingState.userDone` — the server sends `userExists`, so the
 *      "Account ready" step read `undefined` and told every user with an
 *      account that they still needed one.
 *
 *  Typechecking cannot catch this: both sides are valid TypeScript, and
 *  the wrong one is never compared to anything. `docs/api/openapi.json`
 *  is generated from the authored spec and gated against the routes in
 *  CI, so it is the one description of the server that cannot drift.
 *
 *  This asserts the direction that matters: every field an interface
 *  declares must exist in the schema. Declaring FEWER fields than the
 *  server sends is fine and common — the dashboard ignores plenty.
 */
const SPEC = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../docs/api/openapi.json"), "utf8")
) as {
  components: {
    schemas: Record<string, { properties?: Record<string, unknown> }>;
  };
};

const SOURCE = readFileSync(resolve(process.cwd(), "src/lib/api.ts"), "utf8");

/** interface name in api.ts -> schema name in the OpenAPI components.
 *
 *  `MemoryEntry` now carries the optional `signals` object the ranked
 *  routes really return, so SearchResult can be checked against it too.
 *  That binding is the one that would have caught the fourth instance of
 *  this bug: `signals` was typed `{keyword, vector, graph}` while
 *  /v1/search answers with all five, and the dashboard hid `recency`
 *  entirely.
 *
 *  `TokenList` rows are still `additionalProperties: true` — untyped, so
 *  there is nothing to compare — and `Health` describes the `/health`
 *  liveness probe (`{ok}`), not the admin deep-health payload
 *  HealthSnapshot models. Those two remain unbound.
 */
const BINDINGS: Array<[string, string]> = [
  // Would have caught RecentEntry's phantom signals/hits/age/decay.
  ["RecentEntry", "MemoryEntry"],
  // Would have caught SearchResult.signals being three fields, not five.
  ["SearchResult", "MemoryEntry"],
  // Would have caught OnboardingState.userDone.
  ["OnboardingState", "Onboarding"],
  ["RememberResult", "RememberResult"],
  ["Project", "ProjectListItem"],
  ["ProjectMember", "MemberList"],
];

/** Field names declared directly on an interface body. Deliberately a
 *  small parser rather than a TypeScript AST: it only has to read the
 *  flat, hand-written shapes in this one file, and a dependency-free
 *  check is one less thing that can stop running. */
function declaredFields(iface: string): string[] {
  const start = SOURCE.indexOf(`export interface ${iface} {`);
  if (start === -1) throw new Error(`interface ${iface} not found in api.ts`);
  let depth = 0;
  let i = SOURCE.indexOf("{", start);
  const bodyStart = i + 1;
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++;
    else if (SOURCE[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = SOURCE.slice(bodyStart, i);

  const fields: string[] = [];
  let nesting = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    // Only top-level members count; a nested object literal's keys belong
    // to that inline type, not to this interface.
    if (nesting === 0) {
      const m = /^(?:readonly\s+)?([A-Za-z_][\w]*)\??\s*:/.exec(line);
      if (m && !line.startsWith("*") && !line.startsWith("//"))
        fields.push(m[1]!);
    }
    nesting += (line.match(/{/g) ?? []).length;
    nesting -= (line.match(/}/g) ?? []).length;
  }
  return fields;
}

/** Schemas that describe a list wrap the row in a named array property —
 *  `TokenList` is `{tokens: [...]}`. Unwrap to the row's own properties so
 *  a row interface can be compared against it. */
function schemaFields(name: string): string[] {
  const schema = SPEC.components.schemas[name];
  if (!schema) throw new Error(`schema ${name} not in openapi.json`);
  const props = schema.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 1) {
    const only = props[keys[0]!] as {
      type?: string;
      items?: { properties?: Record<string, unknown> };
    };
    if (only?.type === "array" && only.items?.properties) {
      return Object.keys(only.items.properties);
    }
  }
  return keys;
}

describe("api.ts interfaces vs the generated OpenAPI contract", () => {
  it.each(BINDINGS)(
    "%s declares no field the %s schema does not have",
    (iface, schema) => {
      const known = new Set(schemaFields(schema));
      const invented = declaredFields(iface).filter((f) => !known.has(f));
      expect(invented).toEqual([]);
    }
  );

  it("renders exactly the signals the contract defines", async () => {
    // The top-level field check above compares interface members, not the
    // shape *inside* one — and the fourth instance of this bug was a
    // nested shape: `signals` was typed as three fields while /v1/search
    // answers with five, so the dashboard silently dropped `recency`.
    // SIGNAL_ORDER is what KSignals iterates, so comparing it to the
    // schema closes that hole for the one nested object that matters.
    const { SIGNAL_ORDER } = await import("../components/k/KSignals");
    const schema = SPEC.components.schemas.MemoryEntry as {
      properties: { signals?: { properties?: Record<string, unknown> } };
    };
    const inContract = Object.keys(schema.properties.signals?.properties ?? {});
    expect([...SIGNAL_ORDER].sort()).toEqual(inContract.sort());
  });

  it("reads a spec that actually describes the endpoints", () => {
    // Guards the guard: a mistyped path or an empty file would make every
    // assertion above vacuously pass.
    expect(Object.keys(SPEC.components.schemas).length).toBeGreaterThan(20);
    expect(schemaFields("Onboarding")).toContain("userExists");
  });
});
