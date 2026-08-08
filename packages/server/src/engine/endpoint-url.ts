/** Building a chat-completions URL from a configured endpoint.
 *
 * This exists to replace `endpoint.replace(/\/+$/, "")`, which CodeQL flags
 * as a polynomial-ReDoS risk (js/polynomial-redos): matching `\/+$` against a
 * long run of slashes backtracks from every position, so the work is
 * quadratic in the length of that run.
 *
 * In practice the input is an operator-set environment variable rather than
 * anything an attacker reaches, so the realistic risk is low — but the scan
 * is right that the pattern is wrong, and a linear scan is both safer and
 * cheaper than defending the regex. Config also has a way of becoming
 * dynamic later, and by then nobody remembers why the regex was acceptable.
 */

/** 0x2f — '/' */
const SLASH = 47;

/** Strips trailing slashes in one linear pass, no regex and no backtracking. */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === SLASH) end--;
  return s.slice(0, end);
}

/** The chat-completions URL for a configured OpenAI-compatible endpoint. */
export function chatCompletionsURL(endpoint: string): string {
  return stripTrailingSlashes(endpoint) + "/chat/completions";
}
