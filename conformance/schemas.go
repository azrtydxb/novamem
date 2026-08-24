package conformance

// Response shapes, transcribed 1:1 from packages/conformance/src/schemas.ts
// (which transcribed them from live oracle responses). Loose on purpose:
// passthrough everywhere, assert only the fields suites rely on.

// MemoryEntry is one item of `results` from /v1/recent (and /v1/search,
// /v1/neighbors, /v1/context — same engine SearchResult type).
var MemoryEntry = Schema{
	"id":        Str,
	"content":   Str,
	"namespace": Opt(Str),
	"project":   Opt(Null(Str)),
	"tier":      Opt(Enum("warm", "cold")),
	"source":    Opt(Str),
	"score":     Opt(Num),
	"metadata":  Opt(MapOf(Any)),
}

// ErrorBody is the generic `{error}` 4xx/5xx envelope.
var ErrorBody = Schema{"error": Str}

var RememberResponse = Schema{
	"id":           Null(Str),
	"rejected":     Opt(Str),
	"deduplicated": Opt(Bool),
	"embedded":     Opt(Bool),
}

var RecentResponse = Schema{"results": Arr(MemoryEntry)}

var UpdateMemoryResponse = Schema{"id": Str, "updated": Bool, "embeddingChanged": Bool}

var ForgetResponse = Schema{"deleted": Bool, "coldDeleteOk": Bool}

var StatsResponse = Schema{
	"byNamespace": MapOf(Schema{"warm": Num, "cold": Num}),
	"totalWarm":   Num,
	"totalCold":   Num,
	"lastDecayAt": Null(Str),
	"uptimeMs":    Num,
}

var CaptureResponse = Schema{
	"id":           Null(Str),
	"rejected":     Opt(Str),
	"deduplicated": Opt(Bool),
	"updated":      Opt(Bool),
	"superseded":   Opt(Arr(Str)),
	"embedded":     Opt(Bool),
}

var SessionRecapResponse = Schema{"saved": Num, "results": Arr(CaptureResponse)}

var HygieneResponse = Schema{
	"summary": Schema{
		"scanned":                 Num,
		"lowValue":                Num,
		"stale":                   Num,
		"duplicateClusters":       Num,
		"contradictionCandidates": Num,
		"orphanCandidates":        Num,
	},
	"lowValue":                Arr(Any),
	"stale":                   Arr(Any),
	"duplicateClusters":       Arr(Any),
	"contradictionCandidates": Arr(Any),
	"orphanCandidates":        Arr(Any),
}

var EvaluateResponse = Schema{
	"suite":   Str,
	"passed":  Bool,
	"summary": Schema{"total": Num, "passed": Num, "failed": Num},
	"cases":   Arr(Schema{"name": Str, "passed": Bool}),
}

var DecayResponse = Schema{"demoted": Num, "promoted": Num, "expired": Num}

var DreamCycleResponse = Schema{
	"walked":             Num,
	"merged":             Num,
	"edgesPromoted":      Num,
	"factsWalked":        Num,
	"factClustersJudged": Num,
	"factsSuperseded":    Num,
	"durationMs":         Num,
}

var ReapOrphansResponse = Schema{
	"attempted": Num,
	"cleared":   Num,
	"abandoned": Num,
	"pending":   Num,
	"total":     Num,
}

var ObserveResponse = Schema{"observed": Num, "reflected": Bool, "logChars": Num}

var ProjectResponse = Schema{"id": Str, "name": Str, "ownerUserId": Str, "createdAt": Str}

var ActiveProjectResponse = Schema{
	"active": Null(Schema{"id": Str, "name": Opt(Str)}),
}

var TodayResponse = Schema{
	"events": Arr(Schema{
		"kind":    Enum("remember", "token", "project", "audit"),
		"at":      Str,
		"text":    Str,
		"project": Null(Str),
	}),
}

var OnboardingResponse = Schema{
	"bootstrapDone": Bool,
	"userExists":    Bool,
	"mintedToken":   Bool,
	"remembered":    Bool,
	"userId":        Null(Str),
}

var MetricsHistoryResponse = Schema{
	"hours":   Num,
	"samples": Arr(Schema{"sampledAt": Str, "queries": Num, "remembers": Num}),
}

var TokenListResponse = Schema{"tokens": Arr(MapOf(Any))}

var MintTokenResponse = Schema{
	"token":     Str,
	"userId":    Str,
	"createdAt": Str,
	"scope":     Str,
	"projectId": Null(Str),
	"expiresAt": Null(Str),
	"warning":   Str,
}

var MembersResponse = Schema{
	"members": Arr(Schema{"userId": Str, "username": Str, "role": Str, "joinedAt": Str}),
}

var UsageResponse = Schema{
	"entries": Num,
	"quota":   Schema{"maxEntries": Null(Num), "writesPerMinute": Null(Num)},
}

var ChangesResponse = Schema{
	"changes": Arr(Schema{
		"seq":       Num,
		"entryId":   Str,
		"projectId": Null(Str),
		"change":    Enum("created", "updated", "superseded", "deleted", "expired"),
		"detail":    Null(MapOf(Any)),
		"at":        Str,
	}),
	"nextSeq": Null(Num),
}

var ExportResponse = Schema{
	"entries": Arr(Schema{
		"id":        Str,
		"projectId": Null(Str),
		"content":   Str,
		"namespace": Str,
		"source":    Str,
		"createdAt": Str,
		"updatedAt": Str,
	}),
	"nextAfterId": Null(Str),
}

var ImportResponse = Schema{
	"imported":     Num,
	"deduplicated": Num,
	"failed":       Arr(Schema{"index": Num, "error": Str}),
}

var AdminUserRow = Schema{
	"id":         Str,
	"email":      Str,
	"name":       Opt(Null(Str)),
	"role":       Enum("admin", "user"),
	"createdAt":  Str,
	"entryCount": Num,
	"tokenCount": Num,
}

var AdminUsersResponse = Schema{"users": Arr(AdminUserRow)}

var AdminCreateUserResponse = Schema{"userId": Str, "email": Str, "token": Opt(Str)}

var AdminDeleteUserResponse = Schema{
	"deleted":         Bool,
	"entriesRemoved":  Num,
	"tokensRemoved":   Num,
	"projectsDeleted": Arr(Any),
	"coldCleanupOk":   Bool,
}

var AdminQuotaResponse = Schema{
	"userId": Str,
	"quota":  Schema{"maxEntries": Null(Num), "writesPerMinute": Null(Num)},
}

var AdminRevokeResponse = Schema{"revoked": Bool}

var AdminAuditLogEntry = Schema{
	"id":          Num,
	"ts":          Str,
	"actorUserId": Null(Str),
	"actorLabel":  Str,
	"action":      Str,
	"target":      Null(Str),
	"metadata":    Opt(Null(MapOf(Any))),
	"requestIp":   Null(Str),
}

var AdminAuditLogResponse = Schema{"entries": Arr(AdminAuditLogEntry)}

var AdminHealthDeepResponse = Schema{
	"ok": Bool,
	"deps": Schema{
		"warm":     Enum("ok", "unreachable"),
		"cold":     Enum("ok", "unreachable"),
		"embedder": Enum("ok", "failing"),
	},
	"coldProvider":      Enum("pgvector", "qdrant", "none"),
	"pendingEmbeddings": Null(Num),
}
