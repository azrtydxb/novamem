package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// Every tool declares an outputSchema, and the spec then requires a
// successful result to carry structuredContent. Clients that enforce it
// (Claude Code does) reject the whole call otherwise: "Tool X has an
// output schema but did not return structured content". This held for
// every tool from #284 until the field was added.

// advertisedTools returns the names of the tools that declare an
// outputSchema, failing if the surface has none (a vacuous pass).
func advertisedTools(t *testing.T) []string {
	t.Helper()
	var defs []struct {
		Name         string          `json:"name"`
		OutputSchema json.RawMessage `json:"outputSchema"`
	}
	if err := json.Unmarshal(ToolDefinitions(), &defs); err != nil {
		t.Fatal(err)
	}
	var names, without []string
	for _, d := range defs {
		if len(d.OutputSchema) > 0 {
			names = append(names, d.Name)
		} else {
			without = append(without, d.Name)
		}
	}
	// The premise is that every tool declares one; a tool that lost its
	// schema would otherwise just drop out of this test.
	if len(names) == 0 || len(without) > 0 {
		t.Fatalf("tools without an outputSchema: %v (of %d)", without, len(defs))
	}
	return names
}

// echoServer answers every tool with an object naming it, so a result
// can be traced back to its call.
func echoServer(t *testing.T) *Server {
	return testServer(t, Options{
		CookieSecret: testCookieSecret,
		Call: func(_ context.Context, _, name string, _ map[string]any) (any, error) {
			if name == "memory_forget" {
				// One tool fails, so the test also sees the error shape.
				return nil, errors.New("kaput")
			}
			return map[string]any{"tool": name, "n": 1}, nil
		},
	})
}

// checkStructured asserts a successful result carries structuredContent
// equal to its text content, decoded — the spec's SHOULD for backwards
// compatibility is that the two say the same thing.
func checkStructured(t *testing.T, era, name string, res map[string]any) {
	t.Helper()
	sc, ok := res["structuredContent"].(map[string]any)
	if !ok {
		t.Errorf("%s %s: structuredContent missing or not an object: %v", era, name, res)
		return
	}
	content, _ := res["content"].([]any)
	if len(content) != 1 {
		t.Errorf("%s %s: content = %v", era, name, res["content"])
		return
	}
	var fromText map[string]any
	text, _ := content[0].(map[string]any)["text"].(string)
	if err := json.Unmarshal([]byte(text), &fromText); err != nil {
		t.Errorf("%s %s: text content is not the JSON result: %q", era, name, text)
		return
	}
	if !reflect.DeepEqual(sc, fromText) || sc["tool"] != name {
		t.Errorf("%s %s: structuredContent %v, text %v", era, name, sc, fromText)
	}
}

// proved by: dropping StructuredContent from callTool's success result,
// or not copying it into the modern response, fails this test for every
// tool in that era.
func TestEveryToolResultCarriesStructuredContent(t *testing.T) {
	h := streamableHandler(echoServer(t), "user-a")
	sid := openSession(t, h)
	for i, name := range advertisedTools(t) {
		legacy := post(t, h, fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":%q,"arguments":{}}}`, i+10, name),
			map[string]string{"Mcp-Session-Id": sid})
		modern := modernPost(t, h, "tools/call", modernBody(fmt.Sprint(i+10), "tools/call", fmt.Sprintf(`"name":%q,"arguments":{}`, name)),
			map[string]string{"Mcp-Name": name})
		for era, rec := range map[string]*http.Response{"legacy": legacy.Result(), "modern": modern.Result()} {
			var env struct {
				Result map[string]any `json:"result"`
			}
			if err := json.NewDecoder(rec.Body).Decode(&env); err != nil {
				t.Fatalf("%s %s: %v", era, name, err)
			}
			if name == "memory_forget" {
				// A failed call is isError text; structuredContent would
				// have to match the schema, and an error does not.
				if env.Result["isError"] != true || env.Result["structuredContent"] != nil {
					t.Errorf("%s %s: failure = %v", era, name, env.Result)
				}
				continue
			}
			checkStructured(t, era, name, env.Result)
		}
	}
}

// A result that is not a JSON object cannot be structuredContent (the
// spec requires an object), and a text-only success would be rejected
// by the client anyway: it is reported as a tool error.
//
// proved by: returning the text as a success again fails this test.
func TestANonObjectResultIsAToolError(t *testing.T) {
	s := testServer(t, Options{
		CookieSecret: testCookieSecret,
		Call: func(context.Context, string, string, map[string]any) (any, error) {
			return []int{1, 2}, nil
		},
	})
	res := s.callTool(context.Background(), "u", "memory_stats", nil)
	if !res.IsError || res.StructuredContent != nil || !strings.Contains(res.Content[0].Text, "not an object") {
		t.Fatalf("result = %+v", res)
	}
}
