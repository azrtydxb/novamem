package llm

import "testing"

// The parsers are the part of these subsystems that runs against
// adversarial model output, so they carry the check: <think> blocks, code
// fences, wrong-shaped rows and cross-cluster id invention all have to be
// survived rather than crash or corrupt the store.

func TestParseFacts(t *testing.T) {
	raw := "<think>let me reason</think>\n```json\n" + `[
	  {"type":"PREFERENCE ","subject":" the user ","predicate":"prefers","object":"tea","entities":["tea",""," Earl Grey "],"importance":7.6},
	  {"type":"nonsense","subject":"a","predicate":"b","object":"c"},
	  {"type":"fact","subject":"","predicate":"b","object":"c"},
	  {"type":"event","subject":"user","predicate":"visited","object":"Tate","occurredAt":" 2026-01-02 "}
	]` + "\n```"
	facts := parseFacts(raw, 8)
	if len(facts) != 2 {
		t.Fatalf("want 2 facts, got %d: %+v", len(facts), facts)
	}
	f := facts[0]
	if f.Type != "preference" || f.Subject != "the user" || f.Object != "tea" {
		t.Errorf("field normalisation wrong: %+v", f)
	}
	if f.Importance != 5 {
		t.Errorf("importance must clamp to 5, got %d", f.Importance)
	}
	if len(f.Entities) != 2 || f.Entities[1] != "Earl Grey" {
		t.Errorf("entities must drop blanks and trim: %+v", f.Entities)
	}
	if got := FactToText(facts[1]); got != "[event] user visited Tate (2026-01-02)" {
		t.Errorf("FactToText = %q", got)
	}
	if facts := parseFacts(raw, 1); len(facts) != 1 {
		t.Errorf("max cap not applied: %d", len(facts))
	}
	if got := parseFacts("no json here", 8); got != nil {
		t.Errorf("want nil for unparseable output, got %+v", got)
	}
}

func TestParseConsolidationsRejectsCrossClusterPairs(t *testing.T) {
	clusters := [][]ClusterFact{
		{{ID: "a"}, {ID: "b"}},
		{{ID: "c"}, {ID: "d"}},
	}
	raw := `[{"group":1,"superseded":"a","by":"b"},` +
		`{"group":1,"superseded":"a","by":"c"},` + // crosses clusters
		`{"group":2,"superseded":"zz","by":"d"},` + // invented id
		`{"group":2,"superseded":"c","by":"c"}]` // self-supersession
	got := parseConsolidations(raw, clusters)
	if len(got) != 1 || got[0].SupersededID != "a" || got[0].ByID != "b" {
		t.Fatalf("want only the in-cluster pair, got %+v", got)
	}
}

func TestParseNumberAndStringArrays(t *testing.T) {
	if got := parseStringArray("```json\n[\"a\", 3, \" b \", \"\"]\n```"); len(got) != 2 || got[1] != "b" {
		t.Errorf("parseStringArray = %+v", got)
	}
	if got := parseNumberArray("[3, 1.9, 0, -2, \"x\"]"); len(got) != 2 || got[0] != 3 || got[1] != 1 {
		t.Errorf("parseNumberArray = %+v", got)
	}
}

func TestReadCompletionTextReportsWhyItIsEmpty(t *testing.T) {
	reasoning := "thinking..."
	mk := func(content, reason *string, finish string) chatResponse {
		return chatResponse{Choices: []struct {
			Message *struct {
				Content   *string `json:"content"`
				Reasoning *string `json:"reasoning"`
			} `json:"message"`
			FinishReason *string `json:"finish_reason"`
		}{{
			Message: &struct {
				Content   *string `json:"content"`
				Reasoning *string `json:"reasoning"`
			}{Content: content, Reasoning: reason},
			FinishReason: &finish,
		}}}
	}
	if _, reason := readCompletionText(chatResponse{}); reason != "response contained no choices" {
		t.Errorf("no-choices reason = %q", reason)
	}
	if _, reason := readCompletionText(mk(nil, &reasoning, "length")); reason == "" {
		t.Error("reasoning-only response must report a reason")
	}
	ok := "hello"
	if text, reason := readCompletionText(mk(&ok, nil, "stop")); text != "hello" || reason != "" {
		t.Errorf("usable response = %q / %q", text, reason)
	}
}

func TestChatCompletionsURL(t *testing.T) {
	if got := ChatCompletionsURL("http://h/v1///"); got != "http://h/v1/chat/completions" {
		t.Errorf("got %q", got)
	}
}
