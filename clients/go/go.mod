module github.com/azrtydxb/novamem/clients/go

// Deliberately BELOW the Go version of the services that consume this client
// (NovaFlow is on 1.26). A client library's `go` directive is a floor imposed
// on everyone who imports it, and nothing here uses anything newer than
// multi-error Unwrap (1.20) — pinning to the newest toolchain would lock out
// third parties for no benefit while still importing cleanly into 1.26.
go 1.23.0
