package httpapi

import "testing"

// Pins the verbatim transcription of mcp-instructions.ts: the hash was
// computed from the TS source (sha256 of NOVAMEM_INSTRUCTIONS) at port
// time — if either side edits the instructions, this fails and the two
// servers must be re-synced together (feature-freeze rule, design §7).
func TestInstructionsHashMatchesTS(t *testing.T) {
	const tsHash = "52f29c1a8ee13eea344366f08b2c5c2737e1539239cf42c04aa5268518a72d56"
	if got := sha256HexStr(novamemInstructions); got != tsHash {
		t.Fatalf("instructions hash drifted from the TS server: %s", got)
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
