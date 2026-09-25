package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildModel(t *testing.T) {
	m, err := BuildModel("testdata/mini.json", "testdata/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Type{}
	for _, ty := range m.Types {
		byName[ty.Name] = ty
	}
	req, ok := byName["SearchRequest"]
	if !ok {
		t.Fatalf("types = %v, want SearchRequest", m.Types)
	}
	if req.Fields[0].Wire != "contentMode" || req.Fields[0].Ref.Named != "SearchRequestContentMode" {
		t.Errorf("contentMode field = %+v", req.Fields[0])
	}
	if e := byName["SearchRequestContentMode"]; e.Kind != KEnum || len(e.Enum) != 2 {
		t.Errorf("enum = %+v", e)
	}
	if f := byName["MemoryEntry"].Fields; f[1].Wire != "seq" || f[1].Ref.Prim != "int64" {
		t.Errorf("seq = %+v, want int64", f[1])
	}
	for _, f := range req.Fields {
		if f.Wire == "query" && !f.Required {
			t.Error("query must be required")
		}
		if f.Wire == "k" && (f.Required || f.Ref.Prim != "int32") {
			t.Errorf("k = %+v, want optional int32", f)
		}
	}
	if len(m.Methods) != 1 || m.Methods[0].Name != "Client.Search" {
		t.Errorf("methods = %+v", m.Methods)
	}
}

func TestCheckReportsStale(t *testing.T) {
	dir := t.TempDir()
	tmpl := filepath.Join(dir, "tmpl")
	if err := os.MkdirAll(tmpl, 0o755); err != nil {
		t.Fatal(err)
	}
	src := "{{/* lang: x out: x/types.txt */}}{{range .Types}}{{.Name}}\n{{end}}"
	if err := os.WriteFile(filepath.Join(tmpl, "x.tmpl"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out")
	opts := Options{Spec: "testdata/mini.json", Routes: "testdata/routes.json", Templates: tmpl, Out: out}
	if err := Run(opts); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(out, "x/types.txt"))
	if !strings.Contains(string(got), "SearchRequest\n") {
		t.Fatalf("generated = %q", got)
	}
	stale, err := Check(opts)
	if err != nil || len(stale) != 0 {
		t.Fatalf("fresh output reported stale: %v %v", stale, err)
	}
	if err := os.WriteFile(filepath.Join(out, "x/types.txt"), []byte("edited"), 0o644); err != nil {
		t.Fatal(err)
	}
	stale, _ = Check(opts)
	if len(stale) != 1 || stale[0] != "x/types.txt" {
		t.Fatalf("stale = %v, want [x/types.txt]", stale)
	}
	opts.Langs = []string{"y"}
	if stale, _ = Check(opts); len(stale) != 0 {
		t.Fatalf("-lang y still checked lang x: %v", stale)
	}
}

func TestUnsupportedConstructFails(t *testing.T) {
	_, err := BuildModel("testdata/oneof.json", "testdata/routes.json")
	if err == nil || err.Error() != "unsupported oneOf at #/components/schemas/SearchResult/properties/results" {
		t.Fatalf("err = %v", err)
	}
}

func TestRealSpecBuilds(t *testing.T) {
	m, err := BuildModel("../../docs/api/openapi.json", "../contract/routes.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Methods) != 41 {
		t.Errorf("methods = %d, want 41", len(m.Methods))
	}
	seen := map[string]bool{}
	for _, ty := range m.Types {
		seen[ty.Name] = true
	}
	for _, ty := range m.Types {
		if ty.Name != "ChangeFeedChangesItem" {
			continue
		}
		for _, f := range ty.Fields {
			if f.Wire == "seq" && f.Ref.Prim != "int64" {
				t.Errorf("ChangeFeedChangesItem.seq = %+v, want int64 (the spec types it as number)", f.Ref)
			}
		}
	}
	for _, want := range []string{"SearchRequest", "SearchResult", "MemoryEntry", "UpdateRequest", "ProvisionedUser", "UserDeletionPreview", "UserDeletionPreviewWouldDelete"} {
		if !seen[want] {
			t.Errorf("model lacks %s", want)
		}
	}
}
