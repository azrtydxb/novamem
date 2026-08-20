# Conformance suite language decision

Status: open
Created: 2026-08-20
Milestone: full-ts-to-go--everything-but-the-web-ui

## Description

packages/conformance (~850 LOC TS + suites) is the black-box oracle —
deliberately independent of the server implementation. Porting it to Go
removes the last TS test runtime but sacrifices
implemented-in-a-different-stack independence. This epic is the written
decision plus, if port is chosen, the port with case-count parity.
