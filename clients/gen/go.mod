module github.com/azrtydxb/novamem/clients/gen

// Generates each SDK's wire types from docs/api/openapi.json and
// clients/contract/routes.json (ADR 0009). A build tool, never imported by
// an SDK.
go 1.23.0

require github.com/azrtydxb/novamem/clients/contract v0.0.0

replace github.com/azrtydxb/novamem/clients/contract => ../contract
