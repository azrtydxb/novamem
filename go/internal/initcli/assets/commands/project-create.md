---
description: Create a new NovaMem project (sub-brain)
argument-hint: <id> <display-name>
allowed-tools: mcp__novamem__project_create
---

Parse `$ARGUMENTS` as `<id> <display name…>`. The id must be a URL-safe
slug, 2–64 chars, alphanumeric / dot / underscore / dash. Call
`mcp__novamem__project_create` with `{ id, name }` and reply with the
new project record. After creation, future `/remember` and `/recall`
calls scoped to this id will land in the new sub-brain.

ARGUMENTS:
$ARGUMENTS
