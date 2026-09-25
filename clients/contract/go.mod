module github.com/azrtydxb/novamem/clients/contract

// The contract every novamem SDK is checked against. Standard library
// only: the scenario server built from this module runs in every SDK's
// CI job, and a dependency here would become a dependency of all nine.
go 1.23.0
