#!/usr/bin/env node
/**
 * `novamem-login` — tiny helper that exchanges username + password for a
 * dashboard session token. Skills/CLIs that want to call MCP `project.*`
 * tools can pipe the result into NOVAMEM_TOKEN.
 *
 * Usage:
 *   npx @azertydxb/novamem-mcp novamem-login                   # prompts for password (TTY)
 *   NOVAMEM_PASSWORD=… npx @azertydxb/novamem-mcp novamem-login   # non-interactive
 *
 * Env:
 *   NOVAMEM_BASE_URL  default http://localhost:7778
 *   NOVAMEM_USERNAME  required (or first positional arg)
 *   NOVAMEM_PASSWORD  optional; falls back to TTY prompt
 *
 * Output: the plaintext session token to stdout (suitable for `$(...)`).
 * Errors and prompts go to stderr.
 */

import { createInterface } from "node:readline";
import { stdin as input, stderr as errOut } from "node:process";

import { NovamemClient } from "@azertydxb/novamem";

async function promptPassword(): Promise<string> {
  if (!input.isTTY) {
    errOut.write(
      "novamem-login: NOVAMEM_PASSWORD not set and stdin is not a TTY — refusing to prompt.\n",
    );
    process.exit(2);
  }
  errOut.write("Password: ");
  // No-echo isn't natively supported by readline; flip the TTY for the prompt.
  // Fall back to an echoing prompt if termios isn't available.
  const tty = input;
  let listener: ((c: string) => void) | null = null;
  try {
    tty.setRawMode?.(true);
  } catch {
    // ignore — fall through to readline below
  }
  if (tty.setRawMode) {
    return await new Promise<string>((resolve) => {
      let buf = "";
      listener = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            tty.removeListener("data", listener!);
            tty.setRawMode!(false);
            tty.pause();
            errOut.write("\n");
            resolve(buf);
            return;
          }
          if (ch === "") process.exit(130);
          if (ch === "" || ch === "\b") {
            buf = buf.slice(0, -1);
          } else {
            buf += ch;
          }
        }
      };
      tty.setEncoding("utf8");
      tty.resume();
      tty.on("data", listener);
    });
  }
  // Fallback: visible echo. Better than nothing for non-TTY harnesses.
  const rl = createInterface({ input: tty, output: errOut });
  return new Promise((resolve) => rl.question("", (a) => { rl.close(); resolve(a); }));
}

async function main() {
  const baseUrl = process.env.NOVAMEM_BASE_URL ?? "http://localhost:7778";
  const username = process.env.NOVAMEM_USERNAME ?? process.argv[2];
  if (!username) {
    errOut.write("usage: novamem-login [username]\n");
    errOut.write("  set NOVAMEM_USERNAME or pass username as the first arg.\n");
    process.exit(2);
  }
  const password = process.env.NOVAMEM_PASSWORD ?? (await promptPassword());

  const client = new NovamemClient({ baseUrl });
  try {
    const r = await client.login({ username, password });
    process.stdout.write(r.token + "\n");
    errOut.write(
      `# logged in as ${r.user.username} (${r.user.role}); session expires ${r.expiresAt}\n`,
    );
  } catch (err) {
    errOut.write(`novamem-login: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

main();
