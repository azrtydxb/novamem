// Command embed is a deterministic stand-in for an OpenAI-compatible
// embeddings API, for the sdk-smoke CI job:
//
//	embed -addr 127.0.0.1:7779 [-dim 384]
//
// Without an embedder the server marks every search degraded, and a
// degraded search with no results is "unavailable" in every SDK — so the
// smoke's search-after-forget step needs one. Each word is hashed into a
// bucket of a -dim vector, which is then normalised: the same text always
// embeds the same way, texts sharing words land close, and no model is
// downloaded. POST /v1/embeddings {"input": [...]} answers
// {"data": [{"embedding": [...]}, ...]} in input order.
package main

import (
	"encoding/json"
	"flag"
	"hash/fnv"
	"log"
	"math"
	"net/http"
	"strings"
	"unicode"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7779", "listen address")
	dim := flag.Int("dim", 384, "vector dimension (the server's NOVAMEM_EMBEDDINGS_DIM)")
	flag.Parse()
	if *dim <= 0 {
		log.Fatalf("embed: -dim must be positive, got %d", *dim)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/embeddings", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Input []string `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		type item struct {
			Embedding []float64 `json:"embedding"`
			Index     int       `json:"index"`
		}
		out := struct {
			Data []item `json:"data"`
		}{Data: make([]item, len(req.Input))}
		for i, text := range req.Input {
			out.Data[i] = item{Embedding: Embed(text, *dim), Index: i}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	})
	log.Fatal(http.ListenAndServe(*addr, mux))
}

// Embed hashes each lower-cased word of text into one of dim buckets and
// returns the normalised vector. Text with no words embeds as a unit vector
// on bucket 0, so no vector is ever all zeros. dim must be positive (main
// checks the flag).
func Embed(text string, dim int) []float64 {
	v := make([]float64, dim)
	words := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	for _, w := range words {
		h := fnv.New32a()
		_, _ = h.Write([]byte(w))
		v[int(h.Sum32()%uint32(dim))]++
	}
	var norm float64
	for _, x := range v {
		norm += x * x
	}
	if norm == 0 {
		v[0] = 1
		return v
	}
	norm = math.Sqrt(norm)
	for i := range v {
		v[i] /= norm
	}
	return v
}
