# Go CLI tools are shippable artifacts, and the last operator script leaves Node

Status: active
Created: 2026-08-20

## Goal

ADR 0001's channel exists: a tagged release cross-compiles novamem-mcp
and novamem-init for the three supported targets, ships them together in
one archive so the installer's sibling-resolution works, and publishes
checksums plus an install script — verified locally end to end, since
publishing a release is the owner's call, not the agent's. The
qdrant→pgvector operator tool becomes a Go command, so an operator
running the Go server never needs Node for the remediation the server
itself prescribes.
