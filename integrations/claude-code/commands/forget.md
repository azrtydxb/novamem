---
description: Permanently delete a NovaMem entry
argument-hint: <entry-id>
allowed-tools: mcp__novamem__memory_forget
---

Call `mcp__novamem__memory.forget` with `id: $ARGUMENTS`. Forget removes
the warm row, the FTS index, the cold vector, and graph edges — it is
not recoverable. Confirm in one short line whether deletion succeeded.
