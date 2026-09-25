<?php

declare(strict_types=1);

namespace Novamem;

use Novamem\Types as T;

/**
 * The data-plane operations an agent needs. Project and token
 * administration live on Management and Admin, so an agent holding a Client
 * cannot perform them by accident.
 */
final class Client extends Base
{
    /** Durable write with semantic dedup. A declined worthiness gate is not an error: check ->id. */
    public function capture(T\CaptureRequest $request): T\CaptureResult
    {
        if (self::blank($request->content)) {
            throw new NovamemException("capture", "content is required");
        }
        return T\CaptureResult::fromArray(
            $this->t->call(
                "capture",
                "POST",
                "/v1/capture",
                $request->toArray(),
            ),
        );
    }

    public function search(T\SearchRequest $request): T\SearchResult
    {
        if (self::blank($request->query)) {
            throw new NovamemException("search", "query is required");
        }
        $body = $this->t->call(
            "search",
            "POST",
            "/v1/search",
            $request->toArray(),
        );
        self::degradedEmpty("search", $body);
        return T\SearchResult::fromArray($body);
    }

    public function recent(?T\RecentRequest $request = null): T\EntryList
    {
        $body = $this->t->call(
            "recent",
            "POST",
            "/v1/recent",
            (object) ($request ?? new T\RecentRequest())->toArray(),
        );
        self::degradedEmpty("recent", $body);
        return T\EntryList::fromArray($body);
    }

    /** recent() over the last 24 hours. */
    public function today(?T\RecentRequest $request = null): T\EntryList
    {
        $args = ($request ?? new T\RecentRequest())->toArray();
        $args["since"] = new \DateTimeImmutable("-24 hours");
        return $this->recent(T\RecentRequest::fromArray($args));
    }

    public function neighbors(T\NeighborsRequest $request): T\SearchResult
    {
        if (self::blank($request->id)) {
            throw new NovamemException("neighbors", "id is required");
        }
        $body = $this->t->call(
            "neighbors",
            "POST",
            "/v1/neighbors",
            $request->toArray(),
        );
        self::degradedEmpty("neighbors", $body);
        return T\SearchResult::fromArray($body);
    }

    /** Rewrite an entry in place, preserving its id, hits and edges. */
    public function update(
        string $id,
        ?T\UpdateRequest $request = null,
    ): T\UpdateResult {
        if (self::blank($id)) {
            throw new NovamemException("update", "id is required");
        }
        $body = $this->t->call(
            "update",
            "PUT",
            "/v1/memories/" . self::seg(trim($id)),
            (object) ($request ?? new T\UpdateRequest())->toArray(),
        );
        if (is_array($body) && self::blank($body["id"] ?? null)) {
            $body["id"] = trim($id);
        }
        return T\UpdateResult::fromArray($body);
    }

    /**
     * Never reports success on a failed delete. An id that is not in your
     * scope comes back deleted: false with no error.
     */
    public function forget(T\ForgetRequest $request): T\ForgetResult
    {
        if (self::blank($request->id)) {
            throw new NovamemException("forget", "id is required");
        }
        try {
            return T\ForgetResult::fromArray(
                $this->t->call(
                    "forget",
                    "POST",
                    "/v1/forget",
                    $request->toArray(),
                ),
            );
        } catch (NovamemException $e) {
            if ($e->isNotFound()) {
                return new T\ForgetResult(deleted: false, coldDeleteOk: true);
            }
            throw $e;
        }
    }

    /** Unconditional store: no worthiness gate, no dedup pass. */
    public function remember(T\CaptureRequest $request): T\RememberResult
    {
        if (self::blank($request->content)) {
            throw new NovamemException("remember", "content is required");
        }
        return T\RememberResult::fromArray(
            $this->t->call(
                "remember",
                "POST",
                "/v1/remember",
                $request->toArray(),
            ),
        );
    }

    public function context(T\ContextRequest $request): T\SearchResult
    {
        if (self::blank($request->message)) {
            throw new NovamemException("context", "message is required");
        }
        return T\SearchResult::fromArray(
            $this->t->call(
                "context",
                "POST",
                "/v1/context",
                $request->toArray(),
            ),
        );
    }

    public function sessionRecap(
        T\SessionRecapRequest $request,
    ): T\SessionRecapResult {
        return T\SessionRecapResult::fromArray(
            $this->t->call(
                "session-recap",
                "POST",
                "/v1/session-recap",
                (object) $request->toArray(),
            ),
        );
    }

    /** A not-found exception here means the server's observer is disabled. */
    public function contextPrefix(?string $project = null): T\ContextPrefix
    {
        return T\ContextPrefix::fromArray(
            $this->t->call(
                "context-prefix",
                "GET",
                "/v1/context-prefix",
                query: ["project" => $project],
            ),
        );
    }

    public function stats(): T\Stats
    {
        return T\Stats::fromArray($this->t->call("stats", "GET", "/v1/stats"));
    }

    /** A served {"ok": false} — including /health's own 503 — is an answer ("not healthy"), not an outage. */
    public function health(): bool
    {
        try {
            $body = $this->t->call("health", "GET", "/health");
        } catch (NovamemException $e) {
            if ($e->statusCode() === 503) {
                return false;
            }
            throw $e;
        }
        return is_array($body) && ($body["ok"] ?? false) === true;
    }
}
