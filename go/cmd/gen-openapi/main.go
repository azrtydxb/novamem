// Command gen-openapi renders docs/api/openapi.json from the Go
// server's route table. CI runs it and diffs, so the committed contract
// can never drift from what this server serves.
//
// Usage: go run ./cmd/gen-openapi [path]   (default: ../docs/api/openapi.json)
package main

import (
	"fmt"
	"os"

	"github.com/azrtydxb/novamem/go/internal/httpapi"
)

func main() {
	out := "../docs/api/openapi.json"
	if len(os.Args) > 1 {
		out = os.Args[1]
	}
	if err := os.WriteFile(out, httpapi.OpenAPIDocument(), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "gen-openapi:", err)
		os.Exit(1)
	}
	fmt.Println("wrote", out)
}
