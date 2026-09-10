// The black-box conformance oracle. ADR 0003: its independence from the
// server is enforced by discipline — this module imports NOTHING from
// go/internal or clients/go and speaks to the target only over HTTP.
// boundary_test.go turns that rule into a failing test.
module github.com/azrtydxb/novamem/conformance

go 1.26
