#!/usr/bin/env node
import { liveCliMain } from "./novamem-live.js";

liveCliMain().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
