package initcli

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Every JSON config the TypeScript installer produced must survive a
// parse → emit round-trip byte for byte. That is what proves the
// ordered document and the hand-written emitter reproduce
// JSON.stringify(doc, null, 2): key order, two-space indent, escaping,
// trailing newline.
func TestRoundTripsGoldenJSONByteForByte(t *testing.T) {
	var golden map[string]struct {
		Files map[string]string `json:"files"`
	}
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for tool, entry := range golden {
		for name, content := range entry.Files {
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			got := StringifyJSON(ParseJSONLoose(content))
			if got != content {
				t.Errorf("%s/%s round-trip differs:\n--- want ---\n%s\n--- got ---\n%s", tool, name, content, got)
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no JSON fixtures exercised — golden.json is missing or empty")
	}
	t.Logf("round-tripped %d JSON fixtures", checked)
}

func TestParseJSONLooseTolerance(t *testing.T) {
	for _, raw := range []string{"", "   ", "not json", "[1,2]", `"scalar"`, "null"} {
		if d := ParseJSONLoose(raw); d.Len() != 0 {
			t.Errorf("ParseJSONLoose(%q) = %d keys, want an empty document", raw, d.Len())
		}
	}
}

func TestSetKeepsPositionAndDeepSetCreatesPath(t *testing.T) {
	d := ParseJSONLoose(`{"a":1,"b":2}`)
	d.Set("a", "replaced")
	if got := StringifyJSON(d); got != "{\n  \"a\": \"replaced\",\n  \"b\": 2\n}\n" {
		t.Fatalf("updating an existing key moved it:\n%s", got)
	}
	d.DeepSet([]string{"servers", "novamem", "url"}, "https://x")
	if got := d.DeepGet([]string{"servers", "novamem", "url"}); got != "https://x" {
		t.Fatalf("DeepGet after DeepSet = %v", got)
	}
	// A non-object on the path is replaced, matching deepSet in merge.ts.
	d.Set("scalar", 1)
	d.DeepSet([]string{"scalar", "deep"}, true)
	if got := d.DeepGet([]string{"scalar", "deep"}); got != true {
		t.Fatalf("DeepSet did not replace a non-object segment: %v", got)
	}
}
