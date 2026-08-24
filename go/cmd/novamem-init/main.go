// novamem-init configures every supported AI-agent host to talk to a
// novamem server: it signs in, mints a bearer, detects which hosts are
// present, and writes each one an MCP entry, a skill bundle, and slash
// commands.
//
// Ported from the TypeScript @azrtydxb/novamem-init. Two differences,
// both from ADR 0001 (Go tools ship as release binaries, npm is not a
// channel): stdio MCP entries name the shipped novamem-mcp binary
// instead of `npx`, and the pre-flight verifies that binary rather than
// an npm publish. Everything the installer writes is otherwise
// byte-identical, pinned by the golden fixtures in internal/initcli.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/initcli"
	"golang.org/x/term"
)

// version is stamped at build time (-ldflags "-X main.version=…"), the
// way the server binary is; the TypeScript CLI read it from the package
// it shipped inside.
var version = "dev"

type options struct {
	baseURL       string
	email         string
	password      string
	token         string
	tools         string
	all           bool
	yes           bool
	dryRun        bool
	skipShimCheck bool
	mcpBin        string
	showVersion   bool
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(argv []string, stdin *os.File, stdout, stderr *os.File) int {
	var o options
	fs := flag.NewFlagSet("novamem-init", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&o.baseURL, "base-url", os.Getenv("NOVAMEM_BASE_URL"), "novamem server URL")
	fs.StringVar(&o.email, "email", "", "dashboard email (skip prompt)")
	fs.StringVar(&o.password, "password", os.Getenv("NOVAMEM_PASSWORD"), "dashboard password (prefer NOVAMEM_PASSWORD)")
	fs.StringVar(&o.token, "token", os.Getenv("NOVAMEM_TOKEN"), "use an existing nm_… bearer; skip sign-in")
	fs.StringVar(&o.tools, "tools", "", "comma-separated tool ids (default: detected ones)")
	fs.BoolVar(&o.all, "all", false, "configure every tool in the registry, even undetected ones")
	fs.BoolVar(&o.yes, "yes", false, "non-interactive: assume defaults, no confirmation prompt")
	fs.BoolVar(&o.yes, "y", false, "shorthand for --yes")
	fs.BoolVar(&o.dryRun, "dry-run", false, "preview file paths without writing")
	fs.BoolVar(&o.skipShimCheck, "skip-shim-check", false, "skip the pre-flight that verifies the novamem-mcp binary runs")
	fs.StringVar(&o.mcpBin, "mcp-bin", os.Getenv("NOVAMEM_MCP_BIN"), "path to the novamem-mcp binary (default: beside this one, then PATH)")
	fs.BoolVar(&o.showVersion, "version", false, "print the version and exit")
	fs.Usage = func() {
		_, _ = fmt.Fprintf(stderr, "novamem-init — configure AI agent hosts for a novamem server\n\nUsage:\n  novamem-init [flags]\n\nFlags:\n")
		fs.PrintDefaults()
		_, _ = fmt.Fprintf(stderr, "\nTool ids:\n")
		for _, t := range initcli.Tools {
			_, _ = fmt.Fprintf(stderr, "  %-16s %s\n", t.ID, t.Name)
		}
	}
	if err := fs.Parse(argv); err != nil {
		return 2 // flag package already reported it
	}
	if o.showVersion {
		_, _ = fmt.Fprintln(stdout, version)
		return 0
	}

	in := bufio.NewReader(stdin)
	interactive := term.IsTerminal(int(stdin.Fd()))

	state := initcli.LoadState()
	baseURL, err := resolveBaseURL(o, state.LastBaseURL, in, stdout, interactive)
	if err != nil {
		return fail(stderr, err)
	}
	_, _ = fmt.Fprintf(stdout, "✓ Server reachable at %s\n", baseURL)

	bearer, email, err := resolveBearer(o, baseURL, state.LastEmail, in, stdout, interactive)
	if err != nil {
		return fail(stderr, err)
	}

	tools, err := resolveTools(o, in, stdout, interactive)
	if err != nil {
		return fail(stderr, err)
	}
	if len(tools) == 0 {
		_, _ = fmt.Fprintln(stderr, "✗ No tools selected. Pass --all or --tools=<id,…> or run interactively.")
		return 1
	}

	// Pre-flight: if any selected host uses the stdio shim, prove the
	// binary runs BEFORE writing a config that points at it. This is the
	// guard that the npm-era version applied to a published package —
	// the failure it prevents (a host showing "Server disconnected"
	// because the shim never starts) is identical.
	shim := ""
	if needsShim(tools) {
		shim, err = initcli.ResolveShimBinary(o.mcpBin)
		if err != nil {
			return fail(stderr, err)
		}
		if !o.skipShimCheck && !o.dryRun {
			_, _ = fmt.Fprintf(stdout, "→ Pre-flight: verifying %s runs…\n", shim)
			if err := initcli.VerifyShimBinary(shim); err != nil {
				_, _ = fmt.Fprintf(stderr, "✗ Pre-flight failed: %v\n  Refusing to write a stdio config that would silently fail.\n  Pass --skip-shim-check to override at your own risk.\n", err)
				return 1
			}
			_, _ = fmt.Fprintln(stdout, "✓ Shim ready.")
		}
	}

	if !o.yes && !o.dryRun && interactive {
		names := make([]string, 0, len(tools))
		for _, t := range tools {
			names = append(names, t.Name)
		}
		_, _ = fmt.Fprintf(stdout, "\nAbout to configure %d %s: %s.\n", len(tools), plural(len(tools), "tool", "tools"), strings.Join(names, ", "))
		ok, err := confirm(in, stdout, "Proceed? [Y/n] ")
		if err != nil {
			return fail(stderr, err)
		}
		if !ok {
			_, _ = fmt.Fprintln(stdout, "Aborted.")
			return 1
		}
	}

	// The skill bundle and command sources are embedded; stage them so
	// the installers (which take directories) can read them.
	staging, err := os.MkdirTemp("", "novamem-init-assets-")
	if err != nil {
		return fail(stderr, err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	skillDir, commandsDir, err := initcli.MaterializeAssets(staging)
	if err != nil {
		return fail(stderr, err)
	}

	results := initcli.ApplyTools(tools, initcli.RunParams{
		BaseURL:     baseURL,
		Bearer:      bearer,
		Ctx:         initcli.DefaultContext(),
		DryRun:      o.dryRun,
		ShimBinary:  shim,
		SkillDir:    skillDir,
		CommandsDir: commandsDir,
	})
	failed := printSummary(stdout, results, o.dryRun)

	if !o.dryRun {
		initcli.SaveState(initcli.InitState{LastBaseURL: baseURL, LastEmail: email})
	}
	if failed > 0 {
		_, _ = fmt.Fprintf(stderr, "✗ %d %s failed — see above.\n", failed, plural(failed, "host", "hosts"))
		return 1
	}
	return 0
}

func fail(stderr *os.File, err error) int {
	var authErr *initcli.AuthError
	if errors.As(err, &authErr) {
		_, _ = fmt.Fprintf(stderr, "✗ %s\n", authErr.Message)
		return 1
	}
	_, _ = fmt.Fprintf(stderr, "✗ %v\n", err)
	return 1
}

func needsShim(tools []initcli.ToolEntry) bool {
	for _, t := range tools {
		if t.Mcp != nil && t.Mcp.TransportOrDefault() == "stdio" {
			return true
		}
	}
	return false
}

func resolveBaseURL(o options, last string, in *bufio.Reader, stdout *os.File, interactive bool) (string, error) {
	baseURL := o.baseURL
	if baseURL == "" {
		def := last
		if def == "" {
			def = "http://localhost:7778"
		}
		if !interactive {
			return "", fmt.Errorf("--base-url is required when stdin is not a terminal")
		}
		v, err := prompt(in, stdout, fmt.Sprintf("novamem server URL [%s]: ", def))
		if err != nil {
			return "", err
		}
		if v == "" {
			v = def
		}
		baseURL = v
	}
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		return "", fmt.Errorf("server URL must start with http:// or https://")
	}
	if err := initcli.ProbeHealth(baseURL, nil); err != nil {
		return "", err
	}
	return baseURL, nil
}

func resolveBearer(o options, baseURL, lastEmail string, in *bufio.Reader, stdout *os.File, interactive bool) (bearer, email string, err error) {
	if o.token != "" {
		return o.token, "", nil
	}
	email = o.email
	if email == "" {
		if !interactive {
			return "", "", fmt.Errorf("--email (or --token) is required when stdin is not a terminal")
		}
		p := "dashboard email: "
		if lastEmail != "" {
			p = fmt.Sprintf("dashboard email [%s]: ", lastEmail)
		}
		v, err := prompt(in, stdout, p)
		if err != nil {
			return "", "", err
		}
		if v == "" {
			v = lastEmail
		}
		email = v
	}
	if !strings.Contains(email, "@") {
		return "", "", fmt.Errorf("%q is not an email address", email)
	}
	pwd := o.password
	if pwd == "" {
		if !interactive {
			return "", "", fmt.Errorf("--password or NOVAMEM_PASSWORD is required when stdin is not a terminal")
		}
		_, _ = fmt.Fprint(stdout, "dashboard password: ")
		raw, err := term.ReadPassword(int(os.Stdin.Fd()))
		_, _ = fmt.Fprintln(stdout)
		if err != nil {
			return "", "", err
		}
		pwd = string(raw)
	}

	_, _ = fmt.Fprintf(stdout, "→ Signing in as %s…\n", email)
	cookie, err := initcli.SignIn(initcli.SignInOptions{BaseURL: baseURL, Email: email, Password: pwd})
	if err != nil {
		return "", "", err
	}
	_, _ = fmt.Fprintln(stdout, "✓ Signed in. Minting a bearer token…")
	host, _ := os.Hostname()
	label := "novamem-init@" + host
	token, err := initcli.MintToken(initcli.MintTokenOptions{BaseURL: baseURL, SessionCookie: cookie, Label: label})
	if err != nil {
		return "", "", err
	}
	_, _ = fmt.Fprintf(stdout, "✓ Minted token (label: %s)\n", label)
	return token, email, nil
}

func resolveTools(o options, in *bufio.Reader, stdout *os.File, interactive bool) ([]initcli.ToolEntry, error) {
	if o.tools != "" {
		var out []initcli.ToolEntry
		for _, id := range strings.Split(o.tools, ",") {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			t := initcli.FindTool(id)
			if t == nil {
				return nil, fmt.Errorf("unknown tool id: %s. Run with --help to list valid ids", id)
			}
			out = append(out, *t)
		}
		return out, nil
	}
	if o.all {
		return initcli.Tools, nil
	}
	ctx := initcli.DefaultContext()
	detected := initcli.DetectAll(ctx)
	if o.yes || !interactive {
		return detected, nil
	}

	// The TypeScript CLI drew a checkbox list here. A terminal widget is
	// not worth a dependency: the detected set is offered as the default
	// and the user can edit the id list, which is the same decision with
	// less machinery.
	ids := make([]string, 0, len(detected))
	for _, t := range detected {
		ids = append(ids, t.ID)
	}
	_, _ = fmt.Fprintln(stdout, "\nDetected hosts:")
	for _, t := range initcli.Tools {
		mark := " "
		if contains(ids, t.ID) {
			mark = "✓"
		}
		_, _ = fmt.Fprintf(stdout, "  %s %-16s %s\n", mark, t.ID, t.Name)
	}
	def := strings.Join(ids, ",")
	if def == "" {
		def = "(none detected — enter ids, or re-run with --all)"
	}
	v, err := prompt(in, stdout, fmt.Sprintf("\nConfigure which tools? [%s]: ", def))
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(v) != "" {
		o.tools = v
		return resolveTools(o, in, stdout, interactive)
	}
	return detected, nil
}

func printSummary(stdout *os.File, results []initcli.ToolResult, dryRun bool) int {
	verb := "Configured"
	if dryRun {
		verb = "Would configure"
	}
	_, _ = fmt.Fprintf(stdout, "\n%s %d %s:\n\n", verb, len(results), plural(len(results), "tool", "tools"))
	failed := 0
	for _, r := range results {
		_, _ = fmt.Fprintln(stdout, r.Tool.Name)
		var lines []string
		if r.Skill.Written || dryRun {
			lines = append(lines, "  skill   → "+r.Skill.Destination)
		}
		switch {
		case r.Mcp.Changed:
			lines = append(lines, "  mcp     → "+r.Mcp.ConfigPath)
		case !r.Mcp.Skipped:
			lines = append(lines, "  mcp     · already in sync")
		}
		if n := len(r.Commands.FilesWritten); n > 0 {
			dir := ""
			if r.Tool.Commands != nil {
				dir = r.Tool.Commands.Dir
			}
			lines = append(lines, fmt.Sprintf("  cmd     → %d %s in %s", n, plural(n, "file", "files"), dir))
		}
		if r.Err != nil {
			failed++
			lines = append(lines, "  ✗ "+r.Err.Error())
		}
		if len(lines) == 0 {
			lines = append(lines, "  (no-op)")
		}
		for _, l := range lines {
			_, _ = fmt.Fprintln(stdout, l)
		}
		if r.Tool.PostInstallHint != "" {
			_, _ = fmt.Fprintf(stdout, "  ⓘ %s\n", r.Tool.PostInstallHint)
		}
		_, _ = fmt.Fprintln(stdout)
	}
	if dryRun {
		_, _ = fmt.Fprintln(stdout, "Dry run — no files were written.")
	}
	return failed
}

func prompt(in *bufio.Reader, stdout *os.File, message string) (string, error) {
	_, _ = fmt.Fprint(stdout, message)
	line, err := in.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func confirm(in *bufio.Reader, stdout *os.File, message string) (bool, error) {
	v, err := prompt(in, stdout, message)
	if err != nil {
		return false, err
	}
	v = strings.ToLower(v)
	return v == "" || v == "y" || v == "yes", nil
}

func contains(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
