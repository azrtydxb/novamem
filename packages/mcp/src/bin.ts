#!/usr/bin/env node
import { NovamemClient } from "@azrty/novamem";
import { startRemoteMcpStdio } from "./index.js";

const baseUrl = process.env.NOVAMEM_BASE_URL ?? "http://localhost:7778";
const token = process.env.NOVAMEM_TOKEN;

const client = new NovamemClient({ baseUrl, token });
startRemoteMcpStdio(client).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
