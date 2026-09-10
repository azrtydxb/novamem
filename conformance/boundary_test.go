package conformance

// ADR 0003's independence guarantee, as a failing test instead of a
// reviewed rule: the oracle imports NOTHING beyond the standard library —
// no go/internal, no clients/go, no third-party assertion helpers. The
// moment a shared type or helper sneaks in, this fails.

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOracleImportsOnlyTheStandardLibrary(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Clean(e.Name()), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range f.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			if strings.Contains(path, ".") { // stdlib paths have no dot in the first segment
				t.Errorf("%s imports %q — the oracle speaks HTTP only, no shared modules (ADR 0003)", e.Name(), path)
			}
		}
	}
}
