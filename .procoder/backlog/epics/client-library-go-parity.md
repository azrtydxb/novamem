# Client library: Go parity and the npm client's fate

Status: open
Created: 2026-08-20
Milestone: full-ts-to-go--everything-but-the-web-ui

## Description

clients/go already exists (~2,800 LOC, 42 exported methods vs the TS
client's 34 async methods, with a surface test). Remaining work is
proving full coverage and deciding what happens to the published
@azrtydxb/novamem npm package, which external TS consumers may use —
deleting a public npm client is a product decision, not cleanup.
