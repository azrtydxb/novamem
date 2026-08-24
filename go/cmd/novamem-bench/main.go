// novamem-bench runs a benchmark fixture through a retriever and prints
// the report as JSON.
//
// Today it ships the dependency-free lexical retriever, which is what
// the CI smoke gate uses: it needs no model endpoint, so the gate stays
// runnable anywhere. The live-server and LongMemEval runners that the
// TypeScript harness also carried are not ported yet — they need a
// model endpoint to validate against the published numbers, which is
// the remaining half of ADR 0004.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/bench"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "novamem-bench:", err)
		os.Exit(1)
	}
}

func run() error {
	fixturePath := flag.String("fixture", "", "path to a benchmark fixture JSON file")
	out := flag.String("out", "", "write the report here instead of stdout")
	cutoffs := flag.String("cutoffs", "10,20,50,200", "comma-separated k values to score at")
	flag.StringVar(fixturePath, "f", "", "shorthand for --fixture")
	flag.Parse()

	if *fixturePath == "" {
		flag.Usage()
		return fmt.Errorf("--fixture is required")
	}
	raw, err := os.ReadFile(*fixturePath)
	if err != nil {
		return err
	}
	var fixture bench.Fixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		return fmt.Errorf("parse fixture: %w", err)
	}

	kValues, err := parseCutoffs(*cutoffs)
	if err != nil {
		return err
	}
	report, err := bench.Run(fixture, bench.LexicalRetriever, kValues)
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	if *out != "" {
		return os.WriteFile(*out, encoded, 0o644)
	}
	_, err = os.Stdout.Write(encoded)
	return err
}

func parseCutoffs(value string) ([]int, error) {
	var ks []int
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, err := strconv.Atoi(part)
		if err != nil {
			return nil, fmt.Errorf("invalid cutoff %q", part)
		}
		ks = append(ks, k)
	}
	if len(ks) == 0 {
		return nil, fmt.Errorf("no valid cutoffs in %q", value)
	}
	return ks, nil
}
