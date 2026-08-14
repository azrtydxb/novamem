// Package embeddings is the OpenAI-compatible /v1/embeddings client.
// Transcribed from packages/server/src/embeddings.ts (read-only
// reference, never imported). Only the openai-compatible provider is
// ported: the in-process local-transformers path is dropped in the Go
// server by design (go-migration design §5) and refused at config load.
package embeddings

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Kind selects the asymmetric-retrieval prefix ("query" when searching,
// "document" when storing) — embeddings.ts EmbeddingKind.
type Kind string

const (
	KindQuery    Kind = "query"
	KindDocument Kind = "document"
)

type Prefixes struct {
	Query    string
	Document string
}

// PrefixSource — how the prefixes were decided (embeddings.ts).
type PrefixSource string

const (
	SourceExplicit PrefixSource = "explicit"
	SourcePreset   PrefixSource = "preset"
	SourceNone     PrefixSource = "none"
)

// Model prefix presets, keyed by a substring of the model id
// (embeddings.ts MODEL_PREFIX_PRESETS). Order matters: first match wins.
var presets = []struct {
	match    *regexp.Regexp
	prefixes Prefixes
}{
	// intfloat/e5-*, multilingual-e5-*
	{regexp.MustCompile(`(?i)(^|/)(multilingual-)?e5-`), Prefixes{Query: "query: ", Document: "passage: "}},
	// BAAI/bge-*-en / bge-*-en-v1.5 — only the query side is prefixed.
	// bge-m3 deliberately does not match (trained without prefixes).
	{regexp.MustCompile(`(?i)(^|/)bge-.*-(en|zh)(-v\d+(\.\d+)?)?$`), Prefixes{
		Query:    "Represent this sentence for searching relevant passages: ",
		Document: "",
	}},
	// Qwen3-Embedding-* — instruction-aware query envelope.
	{regexp.MustCompile(`(?i)(^|/)qwen3-embedding(-|$)`), Prefixes{
		Query: "Instruct: Given a question or task from a user, retrieve stored memories " +
			"that contain the information needed to answer it\nQuery: ",
		Document: "",
	}},
}

// ResolvePrefixesWithSource — embeddings.ts resolvePrefixesWithSource.
// explicitQuery/explicitDocument are nil when unset; a non-nil empty
// string is an explicit "no prefix" override.
func ResolvePrefixesWithSource(model string, explicitQuery, explicitDocument *string) (Prefixes, PrefixSource) {
	if explicitQuery != nil || explicitDocument != nil {
		p := Prefixes{}
		if explicitQuery != nil {
			p.Query = *explicitQuery
		}
		if explicitDocument != nil {
			p.Document = *explicitDocument
		}
		return p, SourceExplicit
	}
	if model != "" {
		for _, preset := range presets {
			if preset.match.MatchString(model) {
				return preset.prefixes, SourcePreset
			}
		}
	}
	return Prefixes{}, SourceNone
}

// DefaultMaxInputChars — embeddings.ts DEFAULT_MAX_INPUT_CHARS: ~4
// chars/token keeps the input under an 8192-token window; a last-resort
// cap so no input is *unembeddable* (a 4xx would park the row forever).
const DefaultMaxInputChars = 24_000

// CapInputs truncates each text to maxInputChars (UTF-16 units, matching
// JS String.slice) and reports how many were cut. maxInputChars <= 0
// disables the cap.
func CapInputs(texts []string, maxInputChars int) ([]string, int) {
	if maxInputChars <= 0 {
		return texts, 0
	}
	truncated := 0
	out := make([]string, len(texts))
	for i, t := range texts {
		out[i] = t
		if utf16Len(t) > maxInputChars {
			truncated++
			out[i] = utf16Slice(t, maxInputChars)
		}
	}
	return out, truncated
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

// utf16Slice returns the first n UTF-16 code units of s (JS s.slice(0,n)).
// A surrogate pair straddling the boundary is dropped whole — JS would
// keep a lone surrogate, but a lone surrogate is not representable in
// UTF-8, and the cap is a bound, not an exact contract.
func utf16Slice(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

const embeddingAttempts = 3

// NonRetryableError marks a failure retrying cannot fix (bad model id,
// bad API key, malformed request) — embeddings.ts NonRetryableEmbeddingError.
type NonRetryableError struct{ msg string }

func (e *NonRetryableError) Error() string { return e.msg }

type Config struct {
	Endpoint       string // required; trailing "/" stripped
	Model          string // required
	APIKey         string
	Dimensions     int
	TimeoutMs      int // per-request; default 30000
	QueryPrefix    *string
	DocumentPrefix *string
	MaxInputChars  int // 0 → DefaultMaxInputChars (pass -1 to disable? TS: 0 disables via capInputs; cfg unset defaults)
	Log            *slog.Logger
}

// Client is the openai-compatible embedder (embeddings.ts
// OpenAICompatibleEmbedder).
type Client struct {
	endpoint      string
	model         string
	apiKey        string
	dimensions    int
	timeout       time.Duration
	prefixes      Prefixes
	maxInputChars int
	modelID       string
	log           *slog.Logger
	http          *http.Client
}

func New(cfg Config) (*Client, error) {
	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("openai-compatible embeddings require endpoint")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("openai-compatible embeddings require model")
	}
	timeout := 30 * time.Second
	if cfg.TimeoutMs > 0 {
		timeout = time.Duration(cfg.TimeoutMs) * time.Millisecond
	}
	maxInput := cfg.MaxInputChars
	if maxInput == 0 {
		maxInput = DefaultMaxInputChars
	}
	prefixes, _ := ResolvePrefixesWithSource(cfg.Model, cfg.QueryPrefix, cfg.DocumentPrefix)
	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	return &Client{
		endpoint:      strings.TrimSuffix(cfg.Endpoint, "/"),
		model:         cfg.Model,
		apiKey:        cfg.APIKey,
		dimensions:    cfg.Dimensions,
		timeout:       timeout,
		prefixes:      prefixes,
		maxInputChars: maxInput,
		modelID:       "openai-compatible:" + cfg.Model,
		log:           log,
		http:          &http.Client{},
	}, nil
}

// ModelID — stable identifier recorded on every cold-store point so a
// model swap is detectable (embeddings.ts Embedder.modelId).
func (c *Client) ModelID() string { return c.modelID }

func (c *Client) Dimensions() int { return c.dimensions }

// Prefixes exposes the resolved prefix pair (startup logging).
func (c *Client) Prefixes() Prefixes { return c.prefixes }

// Embed one or more texts. kind selects the asymmetric prefix; TS
// defaults to "document" for callers that don't say.
//
// Retry discipline is the TS client's exactly: 3 attempts, backoff
// 250ms·2^(attempt-1), per-attempt timeout; 4xx other than 429 is
// non-retryable and fails fast.
func (c *Client) Embed(ctx context.Context, input []string, kind Kind) ([][]float64, error) {
	prefix := c.prefixes.Document
	if kind == KindQuery {
		prefix = c.prefixes.Query
	}
	raw := make([]string, len(input))
	for i, t := range input {
		raw[i] = prefix + t
	}
	arr, truncated := CapInputs(raw, c.maxInputChars)
	if truncated > 0 {
		c.log.Warn(fmt.Sprintf(
			"[embeddings] truncated %d input(s) to %d chars for %s; the tail is not represented in the vector",
			truncated, c.maxInputChars, c.model))
	}
	body, err := json.Marshal(map[string]any{"input": arr, "model": c.model})
	if err != nil {
		return nil, err
	}

	var lastErr error
	for attempt := 1; attempt <= embeddingAttempts; attempt++ {
		vectors, err := c.attempt(ctx, body)
		if err == nil {
			return vectors, nil
		}
		var nr *NonRetryableError
		if errors.As(err, &nr) {
			return nil, err
		}
		lastErr = err
		if attempt < embeddingAttempts {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(250*(1<<(attempt-1))) * time.Millisecond):
			}
		}
	}
	return nil, lastErr
}

func (c *Client) attempt(ctx context.Context, body []byte) ([][]float64, error) {
	reqCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.endpoint+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("authorization", "Bearer "+c.apiKey)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close() //nolint:errcheck
	if res.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		msg := fmt.Sprintf("embeddings http %d: %s", res.StatusCode, string(detail))
		// 4xx other than 429 is a caller/config problem — fail fast.
		if res.StatusCode < 500 && res.StatusCode != http.StatusTooManyRequests {
			return nil, &NonRetryableError{msg: msg}
		}
		return nil, fmt.Errorf("%s", msg)
	}
	var parsed struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	out := make([][]float64, len(parsed.Data))
	for i, d := range parsed.Data {
		out[i] = d.Embedding
	}
	return out, nil
}
