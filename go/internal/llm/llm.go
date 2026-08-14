// Package llm is the shared OpenAI-compatible chat-completions client the
// three LLM-backed subsystems use: fact extraction, the observer/reflector
// and query decomposition + coherence rerank. Transcribed from
// packages/server/src/engine/llm-response.ts and endpoint-url.ts
// (read-only reference, never imported).
//
// All three call EXTERNAL endpoints (NOVAMEM_{EXTRACTION,OBSERVER,
// QUERY_DECOMP}_ENDPOINT) — no model is hosted in-process.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// slash — 0x2f. stripTrailingSlashes is a linear scan, not a regex
// (endpoint-url.ts: `\/+$` is a polynomial-ReDoS shape).
func stripTrailingSlashes(s string) string {
	end := len(s)
	for end > 0 && s[end-1] == '/' {
		end--
	}
	return s[:end]
}

// ChatCompletionsURL — the chat-completions URL for a configured
// OpenAI-compatible endpoint.
func ChatCompletionsURL(endpoint string) string {
	return stripTrailingSlashes(endpoint) + "/chat/completions"
}

// Message is one chat turn.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Config is the shared shape of an endpoint + model + credential + budget.
type Config struct {
	Endpoint  string
	Model     string
	APIKey    string
	TimeoutMs int
}

// client wraps the HTTP transport; every subsystem embeds one.
type client struct {
	cfg  Config
	http *http.Client
}

func newClient(cfg Config) client {
	return client{cfg: cfg, http: &http.Client{}}
}

// chatCompletionBody — llm-response.ts chatCompletionBody. temperature 0
// and `chat_template_kwargs.enable_thinking:false` (the vLLM/SGLang
// convention for suppressing a reasoning model's chain of thought;
// servers that don't recognise it ignore the field).
func chatCompletionBody(model string, messages []Message, maxTokens int) ([]byte, error) {
	return json.Marshal(map[string]any{
		"model":                model,
		"messages":             messages,
		"temperature":          0,
		"max_tokens":           maxTokens,
		"chat_template_kwargs": map[string]any{"enable_thinking": false},
	})
}

type chatResponse struct {
	Choices []struct {
		Message *struct {
			Content   *string `json:"content"`
			Reasoning *string `json:"reasoning"`
		} `json:"message"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func finishReason(s *string) string {
	if s == nil {
		return "unknown"
	}
	return *s
}

// readCompletionText — llm-response.ts readCompletionText. Reports WHY a
// response was unusable instead of flattening it to "": silence is what
// made a configured-but-inert LLM feature expensive to find.
func readCompletionText(resp chatResponse) (text string, emptyReason string) {
	if len(resp.Choices) == 0 {
		return "", "response contained no choices"
	}
	choice := resp.Choices[0]
	var content, reasoning string
	if choice.Message != nil {
		content = deref(choice.Message.Content)
		reasoning = deref(choice.Message.Reasoning)
	}
	if strings.TrimSpace(content) != "" {
		return content, ""
	}
	if strings.TrimSpace(reasoning) != "" {
		return "", fmt.Sprintf(
			"model returned reasoning only (%d chars, finish_reason=%s) and no content — "+
				"the endpoint ignored enable_thinking:false; raise max_tokens or use a non-reasoning model",
			utf16Len(reasoning), finishReason(choice.FinishReason))
	}
	if finishReason(choice.FinishReason) == "length" {
		return "", "response hit the max_tokens budget before emitting content"
	}
	return "", fmt.Sprintf("response carried no content (finish_reason=%s)", finishReason(choice.FinishReason))
}

// errNotOK marks a non-2xx upstream reply. Every caller mirrors the TS
// `if (!resp.ok) return <neutral>` branch, so this never escapes.
var errNotOK = fmt.Errorf("chat completion endpoint returned a non-OK status")

// complete POSTs one chat completion and returns the assistant text.
// A non-OK status yields errNotOK (callers fall back neutrally, as in
// TS); an unusable body yields the readCompletionText reason wrapped with
// `label`, exactly as TS throws `new Error(\`${label}: ${reason}\`)`.
func (c client) complete(ctx context.Context, label string, messages []Message, maxTokens int) (string, error) {
	body, err := chatCompletionBody(c.cfg.Model, messages, maxTokens)
	if err != nil {
		return "", err
	}
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(c.cfg.TimeoutMs)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost,
		ChatCompletionsURL(c.cfg.Endpoint), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json")
	if c.cfg.APIKey != "" {
		req.Header.Set("authorization", "Bearer "+c.cfg.APIKey)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close() //nolint:errcheck
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", errNotOK
	}
	var parsed chatResponse
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return "", err
	}
	text, reason := readCompletionText(parsed)
	if reason != "" {
		return "", fmt.Errorf("%s: %s", label, reason)
	}
	return text, nil
}

// ─── Response cleaning (shared by all three subsystems) ────────────────

var (
	thinkRe     = regexp.MustCompile(`(?is)<think>.*?</think>`)
	fenceOpenRe = regexp.MustCompile("(?i)^\\s*```(?:json)?\\s*")
	// The observer strips a ```markdown fence instead of ```json.
	fenceOpenMarkdownRe = regexp.MustCompile("(?i)^\\s*```(?:markdown)?\\s*")
	fenceCloseRe        = regexp.MustCompile("(?i)```\\s*$")
	// First JSON array in the response — greedy, first '[' to last ']'.
	jsonArrayRe = regexp.MustCompile(`(?s)\[.*\]`)
)

// stripJSONFences — the `<think>` + ```json cleaning every JSON-shaped
// parser here applies before looking for the array.
func stripJSONFences(s string) string {
	s = thinkRe.ReplaceAllString(s, "")
	s = strings.TrimSpace(s)
	s = fenceOpenRe.ReplaceAllString(s, "")
	s = fenceCloseRe.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

// stripMarkdownFences — observer.ts stripFences (```markdown, not ```json).
func stripMarkdownFences(s string) string {
	s = thinkRe.ReplaceAllString(s, "")
	s = fenceOpenMarkdownRe.ReplaceAllString(s, "")
	s = fenceCloseRe.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

// firstJSONArray returns the raw text of the first JSON array, or "".
func firstJSONArray(s string) string { return jsonArrayRe.FindString(s) }

// utf16Len / utf16Slice give JS `String.length` and `.slice(0, n)`
// semantics, which the prompts' character budgets are expressed in.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

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

// semaphore is the Promise-based Semaphore from fact-extractor.ts: a
// bounded slot pool that queues callers rather than rejecting them.
type semaphore chan struct{}

func newSemaphore(capacity int) semaphore {
	if capacity < 1 {
		capacity = 1
	}
	return make(semaphore, capacity)
}

func (s semaphore) acquire() { s <- struct{}{} }
func (s semaphore) release() { <-s }
