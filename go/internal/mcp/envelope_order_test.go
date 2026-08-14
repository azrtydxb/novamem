package mcp

import (
	"encoding/json"
	"testing"
)

// TS emits {jsonrpc, error, id}; encoding/json sorts map keys, which
// silently reordered these envelopes.
func TestRPCErrorEnvelopeKeyOrder(t *testing.T) {
	b, err := json.Marshal(rpcErrEnvelope(-32000, "boom"))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"jsonrpc":"2.0","error":{"code":-32000,"message":"boom"},"id":null}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
}
