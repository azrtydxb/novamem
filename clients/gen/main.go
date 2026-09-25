// Command gen writes each novamem SDK's wire types and scenario dispatch
// table from docs/api/openapi.json and clients/contract/routes.json.
//
//	go run ./clients/gen -spec docs/api/openapi.json -routes clients/contract/routes.json -out clients [-check] [-lang python,rust]
//
// -check writes nothing, prints "stale: <path>" per out-of-date file, and
// exits 1 if there is any. Exit 2 is a generator error, such as a schema
// construct it does not support.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

func main() {
	var opts Options
	var langs string
	check := flag.Bool("check", false, "report stale files instead of writing")
	flag.StringVar(&opts.Spec, "spec", "docs/api/openapi.json", "OpenAPI JSON document")
	flag.StringVar(&opts.Routes, "routes", "clients/contract/routes.json", "route map")
	flag.StringVar(&opts.Templates, "templates", "clients/gen/templates", "template directory")
	flag.StringVar(&opts.Out, "out", "clients", "output root")
	flag.StringVar(&langs, "lang", "", "comma-separated languages (default: all)")
	flag.Parse()
	if langs != "" {
		opts.Langs = strings.Split(langs, ",")
	}

	if !*check {
		if err := Run(opts); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		return
	}
	stale, err := Check(opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	for _, p := range stale {
		fmt.Println("stale:", p)
	}
	if len(stale) > 0 {
		os.Exit(1)
	}
}
