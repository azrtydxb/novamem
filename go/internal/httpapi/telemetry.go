package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type telemetryGroup struct {
	Key   string `json:"key"`
	Count int64  `json:"count"`
}

type telemetryDay struct {
	Date  string `json:"date"`
	Count int64  `json:"count"`
}

type telemetryAgent struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// handleAdminTelemetry exposes aggregate counters only. It deliberately
// never selects memory content, metadata blobs, user identifiers, or project
// names. Sensitivity and daily growth are limited to 30 days because there
// is no general created_at or metadata-sensitivity index; no new index or
// unbounded history scan is introduced here.
func (s *server) handleAdminTelemetry(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	p := s.warm.Pool

	var total, embedded, pending, extractionPending int64
	if err := p.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE embedded_at IS NOT NULL),
		count(*) FILTER (WHERE embedded_at IS NULL),
		count(*) FILTER (WHERE facts_pending_at IS NOT NULL) FROM memory_entries`).Scan(&total, &embedded, &pending, &extractionPending); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	pendingOrphans, err := s.warm.CountColdOrphans(ctx)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	byNamespace, err := telemetryGroups(ctx, p, `SELECT namespace, count(*) FROM memory_entries GROUP BY namespace ORDER BY count(*) DESC LIMIT 100`)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	byProject, err := telemetryGroups(ctx, p, `SELECT COALESCE(project_id, 'unassigned'), count(*) FROM memory_entries GROUP BY project_id ORDER BY count(*) DESC LIMIT 100`)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	bySensitivity, err := telemetryGroups(ctx, p, `SELECT COALESCE(metadata->>'sensitivity', 'unspecified'), count(*) FROM memory_entries WHERE created_at >= current_date - interval '29 days' AND created_at < current_date + interval '1 day' GROUP BY metadata->>'sensitivity' ORDER BY count(*) DESC LIMIT 10`)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	byTier, err := telemetryTierGroups(ctx, p)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	topAgents, err := telemetryAgents(ctx, p)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	createdPerDay, err := telemetryGrowth(ctx, p)
	if err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	var lastDecayAt *time.Time
	if err := p.QueryRow(ctx, `SELECT (SELECT finished_at FROM decay_runs ORDER BY id DESC LIMIT 1)`).Scan(&lastDecayAt); err != nil {
		s.sendEngineErr(w, r, err)
		return
	}
	health := s.engine.Health(ctx)
	writeJSONValue(w, http.StatusOK, map[string]any{
		"totalEntries": total, "embeddedEntries": embedded, "pendingEmbeddings": pending,
		"pendingExtractions": extractionPending, "pendingColdOrphans": pendingOrphans, "byNamespace": byNamespace,
		"byProject": byProject, "bySensitivity": bySensitivity, "byTier": byTier,
		"createdPerDay": createdPerDay, "topAgents": topAgents, "lastDecayAt": lastDecayAt,
		"health": health,
	})
}

func telemetryGroups(ctx context.Context, p *pgxpool.Pool, q string) ([]telemetryGroup, error) {
	rows, err := p.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []telemetryGroup{}
	for rows.Next() {
		var row telemetryGroup
		if err := rows.Scan(&row.Key, &row.Count); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func telemetryTierGroups(ctx context.Context, p *pgxpool.Pool) ([]telemetryGroup, error) {
	return telemetryGroups(ctx, p, `SELECT CASE WHEN cold THEN 'cold' ELSE 'warm' END, count(*) FROM memory_entries GROUP BY cold ORDER BY cold`)
}

func telemetryAgents(ctx context.Context, p *pgxpool.Pool) ([]telemetryAgent, error) {
	rows, err := p.Query(ctx, `SELECT agent_name, count(*) FROM memory_entries WHERE agent_name IS NOT NULL AND agent_name <> '' GROUP BY agent_name ORDER BY count(*) DESC LIMIT 10`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []telemetryAgent{}
	for rows.Next() {
		var row telemetryAgent
		if err := rows.Scan(&row.Name, &row.Count); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func telemetryGrowth(ctx context.Context, p *pgxpool.Pool) ([]telemetryDay, error) {
	rows, err := p.Query(ctx, `SELECT to_char(day, 'YYYY-MM-DD'), COALESCE(count, 0) FROM generate_series(current_date - interval '29 days', current_date, interval '1 day') AS day LEFT JOIN (SELECT date_trunc('day', created_at) AS day, count(*) FROM memory_entries WHERE created_at >= current_date - interval '29 days' AND created_at < current_date + interval '1 day' GROUP BY 1) recent USING (day) ORDER BY day`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []telemetryDay{}
	for rows.Next() {
		var row telemetryDay
		if err := rows.Scan(&row.Date, &row.Count); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
