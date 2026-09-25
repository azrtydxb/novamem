/**
 * TypeScript client for novamem, a tiered memory service for agents.
 *
 * ```ts
 * import { Client, isUnavailable } from "@azrtydxb/novamem";
 *
 * const c = new Client({ baseUrl: "https://novamem.example.com", token });
 * await c.capture({ content: "User prefers dark roast" });
 * try {
 *   const { results } = await c.search({ query: "coffee preference", k: 5 });
 *   if (results.length === 0) {
 *     // "Nothing is stored about that." This one is knowledge.
 *   }
 * } catch (e) {
 *   if (isUnavailable(e)) {
 *     // "I could not look." Say so; do not claim ignorance.
 *   }
 * }
 * ```
 */
export { Admin, Client, Management } from "./client.js";
export {
  NovamemError,
  isNotFound,
  isRetryable,
  isUnavailable,
} from "./errors.js";
export {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  type CallOptions,
  type ClientOptions,
} from "./transport.js";
export type * from "./types.js";
