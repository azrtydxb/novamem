// Observer / Reflector engine methods — the observation-log pipeline
// behind POST /v1/observe and GET /v1/context-prefix. Transcribed from
// packages/server/src/engine/index.ts (getContextPrefix, runObserver) and
// engine/observer.ts (getPrefix, upsertPrefix).
//
// The log is a single per-(user, project) markdown blob stored as a
// memory_entries row with source_type = "observation" in the
// `__observation__` namespace. Callers feed it to their own LLM as a
// static, prompt-cacheable prefix instead of doing dynamic retrieval.
package engine

import (
	"context"
	"strings"

	"github.com/azrtydxb/novamem/go/internal/warmstore"
)

// observationNamespace — the stable namespace key for the blob
// (observer.ts Observer.namespace()).
const observationNamespace = "__observation__"

// ObserverResult — POST /v1/observe's body.
type ObserverResult struct {
	Observed  int  `json:"observed"`
	Reflected bool `json:"reflected"`
	LogChars  int  `json:"logChars"`
}

// GetContextPrefix returns the cacheable observation prefix for a scope,
// or nil when no observer is wired — the route surfaces that as a 404.
func (e *Engine) GetContextPrefix(ctx context.Context, userID string, projectID *string) (*string, error) {
	if e.observer == nil {
		return nil, nil
	}
	prefix, err := e.observationPrefix(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	return &prefix, nil
}

// observationPrefix — observer.ts getPrefix: the newest blob in scope,
// or "" when there is none.
func (e *Engine) observationPrefix(ctx context.Context, userID string, projectID *string) (string, error) {
	rows, err := e.warm.ListRecent(ctx, userID, []string{observationNamespace}, 1, projectID, nil, nil)
	if err != nil {
		return "", err
	}
	if len(rows) == 0 {
		return "", nil
	}
	return rows[0].Content, nil
}

// upsertObservationPrefix — observer.ts upsertPrefix: overwrite the
// existing blob in scope, or insert a fresh one.
func (e *Engine) upsertObservationPrefix(ctx context.Context, userID string, projectID *string, body string) error {
	rows, err := e.warm.ListRecent(ctx, userID, []string{observationNamespace}, 1, projectID, nil, nil)
	if err != nil {
		return err
	}
	if len(rows) > 0 {
		_, err := e.warm.UpdateEntry(ctx, warmstore.UpdateEntryArgs{
			UserID:    userID,
			ID:        rows[0].ID,
			ProjectID: projectID,
			Content:   &body,
		})
		return err
	}
	sourceType := "observation"
	confidence := 1.0
	_, err = e.warm.InsertEntry(ctx, NewULID(), warmstore.InsertEntryArgs{
		UserID:     userID,
		ProjectID:  projectID,
		Content:    body,
		Namespace:  observationNamespace,
		Source:     "observer",
		Metadata:   map[string]any{"kind": "observation"},
		SourceType: &sourceType,
		Confidence: &confidence,
		// contentHash stays NULL: the blob is rewritten in place, so a
		// dedup key would only fight the overwrite.
	})
	return err
}

// RunObserver runs an observer pass and, if the log grew past the reflect
// trigger, a reflector pass. Returns nil when no observer is wired — the
// route surfaces that as a 503.
func (e *Engine) RunObserver(ctx context.Context, userID string, projectID *string, limit int) (*ObserverResult, error) {
	if e.observer == nil {
		return nil, nil
	}
	if limit <= 0 {
		limit = 20
	}
	rows, err := e.warm.ListRecent(ctx, userID, []string{"default"}, limit, projectID, nil, nil)
	if err != nil {
		return nil, err
	}
	// Skip the observer-managed namespace (belt and braces: the query
	// above already asks only for "default").
	var chunks []string
	for _, r := range rows {
		if r.Namespace == observationNamespace {
			continue
		}
		chunks = append(chunks, r.Content)
	}
	newBullets := ""
	if len(chunks) > 0 {
		newBullets, err = e.observer.Observe(ctx, chunks)
		if err != nil {
			return nil, err
		}
	}
	existing, err := e.observationPrefix(ctx, userID, projectID)
	if err != nil {
		return nil, err
	}
	separator := ""
	if existing != "" && newBullets != "" {
		separator = "\n"
	}
	combined := strings.TrimSpace(existing + separator + newBullets)
	reflected := false
	// Literal 50, as in TS: the reflect trigger is the bullet count of the
	// combined log, and observer.reflectThreshold — while read from the
	// environment into the observer's config — is not what gates it there.
	if len(strings.Split(combined, "\n")) > 50 {
		compacted, err := e.observer.Reflect(ctx, combined)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(compacted) != "" {
			combined = strings.TrimSpace(compacted)
			reflected = true
		}
	}
	if combined != "" {
		if err := e.upsertObservationPrefix(ctx, userID, projectID, combined); err != nil {
			return nil, err
		}
	}
	return &ObserverResult{
		Observed:  len(chunks),
		Reflected: reflected,
		LogChars:  utf16Len(combined),
	}, nil
}
