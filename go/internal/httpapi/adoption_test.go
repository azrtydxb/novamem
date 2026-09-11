package httpapi

import "testing"

// The instructions are rendered from the marked regions of
// skills/novamem/SKILL.md, so an edit there changes what every MCP
// client is told on connect and changes the adoption report's
// instructionsHash, which clients use to decide whether to reload.
// That should always be a deliberate, reviewed change — so it is
// pinned, and updating the skill means updating this hash in the same
// commit.
//
// The pin used to hold the retired TypeScript server's hash, to keep
// the two implementations byte-identical during the port. That server
// no longer exists; the pin's job now is to make an accidental edit
// impossible to merge unnoticed.
func TestInstructionsHashIsPinned(t *testing.T) {
	const want = "db3dd918d08b0ab2c38fb52da3a13fb5a583d346c8353694b0b0bf331cbb0fcf"
	got := sha256HexStr(novamemInstructions)
	if got != want {
		t.Fatalf("instructions changed.\n got  %s\n want %s\n"+
			"If you edited skills/novamem/SKILL.md inside an mcp-instructions region, "+
			"that is expected — update this pin in the same commit.", got, want)
	}
}

func TestAdoptionReportShape(t *testing.T) {
	report := buildAdoptionReport(adoptionOptions{})
	mcp := report.get("mcp").(obj)
	if mcp.get("toolCount") != 21 {
		t.Fatalf("toolCount %v, want 21 (14 memory_* + 7 project_*)", mcp.get("toolCount"))
	}
	if report.get("requestedClient") != "generic" {
		t.Fatalf("requestedClient %v", report.get("requestedClient"))
	}
	diags := report.get("diagnostics").([]obj)
	if len(diags) != 3 || diags[0].get("status") != "unknown" || diags[0].get("ok") != false {
		t.Fatalf("diagnostics %v", diags)
	}
	if diags[2].get("ok") != true {
		t.Fatal("mandatory_protocol must hold for this build")
	}

	// Observed tools matching the full surface → tool_surface ok.
	tools := append([]string{}, toolNames...)
	report = buildAdoptionReport(adoptionOptions{ObservedTools: tools, ObservedToolsSet: true})
	diags = report.get("diagnostics").([]obj)
	if diags[0].get("status") != "ok" || diags[0].get("ok") != true || diags[0].get("action") != "none" {
		t.Fatalf("tool_surface with full observed set: %v", diags[0])
	}

	// A missing required tool reads as stale.
	report = buildAdoptionReport(adoptionOptions{ObservedTools: tools[1:], ObservedToolsSet: true})
	diags = report.get("diagnostics").([]obj)
	if diags[0].get("status") != "stale" {
		t.Fatalf("missing tool must be stale: %v", diags[0])
	}
}
