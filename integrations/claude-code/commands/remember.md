---
description: Save a memory to NovaMem (durable across sessions)
argument-hint: <content to remember>
allowed-tools: mcp__novamem__memory_remember
---

Store the following as a NovaMem memory entry by calling
`mcp__novamem__memory.remember`. If the user is currently working in a
specific project (visible in their recent context), pass `project: <id>`
to scope it; otherwise leave project unset for a tenant-wide entry.

After saving, reply in one short sentence with the assigned id and a
one-line summary of what was saved, so the user can edit or `/forget`
if needed.

CONTENT TO REMEMBER:
$ARGUMENTS
