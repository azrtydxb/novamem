package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"text/template"
)

// Options drive one generator run.
type Options struct {
	Spec, Routes, Templates, Out string
	// Langs, when set, limits the run to templates whose directive names
	// one of these languages.
	Langs []string
}

// directive is the first line of every template:
// {{/* lang: <lang> out: <path relative to Out> */}}
var directive = regexp.MustCompile(`^\{\{/\* lang: (\S+) out: (\S+) \*/\}\}`)

type rendered struct {
	path string // relative to Out
	body []byte
}

func render(opts Options) ([]rendered, error) {
	model, err := BuildModel(opts.Spec, opts.Routes)
	if err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(opts.Templates, "*.tmpl"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	funcs := template.FuncMap{
		"pascal": pascal, "camel": camel, "snake": snake, "upperSnake": upperSnake,
		"wire": func(f Field) string { return f.Wire },
		"join": strings.Join,
	}
	var out []rendered
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		m := directive.FindSubmatch(src)
		if m == nil {
			return nil, fmt.Errorf("%s: first line must be {{/* lang: <lang> out: <path> */}}", f)
		}
		lang, path := string(m[1]), string(m[2])
		if len(opts.Langs) > 0 && !slices.Contains(opts.Langs, lang) {
			continue
		}
		t, err := template.New(filepath.Base(f)).Funcs(funcs).Parse(string(src))
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		if err := t.Execute(&buf, model); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		body := bytes.ReplaceAll(buf.Bytes(), []byte("\r\n"), []byte("\n"))
		body = append(bytes.TrimRight(body, "\n"), '\n')
		out = append(out, rendered{path: path, body: body})
	}
	return out, nil
}

// Run writes every template's output under opts.Out.
func Run(opts Options) error {
	files, err := render(opts)
	if err != nil {
		return err
	}
	for _, r := range files {
		p := filepath.Join(opts.Out, r.path)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, r.body, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// Check writes nothing and returns the output paths whose file on disk
// differs from what Run would write.
func Check(opts Options) ([]string, error) {
	files, err := render(opts)
	if err != nil {
		return nil, err
	}
	var stale []string
	for _, r := range files {
		have, err := os.ReadFile(filepath.Join(opts.Out, r.path))
		if err != nil || !bytes.Equal(have, r.body) {
			stale = append(stale, r.path)
		}
	}
	return stale, nil
}
