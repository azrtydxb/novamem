<?php

declare(strict_types=1);

namespace Novamem;

use Novamem\Types as T;

/**
 * The caller's own /v1/me/* surface: tokens, projects and members, the
 * active project, and the maintenance endpoints.
 */
final class Management extends Base
{
    public function mintToken(
        ?T\MintTokenRequest $request = null,
    ): T\MintedToken {
        return T\MintedToken::fromArray(
            $this->t->call(
                "mint-token",
                "POST",
                "/v1/me/tokens",
                (object) ($request ?? new T\MintTokenRequest())->toArray(),
            ),
        );
    }

    public function listTokens(): T\TokenList
    {
        return T\TokenList::fromArray(
            $this->t->call("list-tokens", "GET", "/v1/me/tokens"),
        );
    }

    public function revokeToken(string $hash): T\TokenDeleted
    {
        if (self::blank($hash)) {
            throw new NovamemException("revoke-token", "tokenHash is required");
        }
        return T\TokenDeleted::fromArray(
            $this->t->call(
                "revoke-token",
                "DELETE",
                "/v1/me/tokens/" . self::seg(trim($hash)),
            ),
        );
    }

    public function listProjects(): T\ProjectList
    {
        return T\ProjectList::fromArray(
            $this->t->call("list-projects", "GET", "/v1/me/projects"),
        );
    }

    public function createProject(string $name): T\Project
    {
        if (self::blank($name)) {
            throw new NovamemException("create-project", "name is required");
        }
        return T\Project::fromArray(
            $this->t->call("create-project", "POST", "/v1/me/projects", [
                "name" => $name,
            ]),
        );
    }

    public function deleteProject(string $id): T\ProjectDeleted
    {
        if (self::blank($id)) {
            throw new NovamemException("delete-project", "id is required");
        }
        return T\ProjectDeleted::fromArray(
            $this->t->call(
                "delete-project",
                "DELETE",
                "/v1/me/projects/" . self::seg($id),
            ),
        );
    }

    public function listProjectMembers(string $id): T\MemberList
    {
        if (self::blank($id)) {
            throw new NovamemException("list-members", "id is required");
        }
        return T\MemberList::fromArray(
            $this->t->call(
                "list-members",
                "GET",
                "/v1/me/projects/" . self::seg($id) . "/members",
            ),
        );
    }

    /**
     * Adds a user by their EXACT sign-in email (the wire field is named
     * "username" for historical reasons). $role is "member" or "owner".
     */
    public function addProjectMember(
        string $id,
        string $email,
        ?string $role = null,
    ): T\MemberAdded {
        if (self::blank($id) || self::blank($email)) {
            throw new NovamemException(
                "add-member",
                "id and email are required",
            );
        }
        $body = self::compact(["username" => $email, "role" => $role]);
        return T\MemberAdded::fromArray(
            $this->t->call(
                "add-member",
                "POST",
                "/v1/me/projects/" . self::seg($id) . "/members",
                $body,
            ),
        );
    }

    public function removeProjectMember(
        string $id,
        string $userId,
    ): T\MemberRemoved {
        if (self::blank($id) || self::blank($userId)) {
            throw new NovamemException(
                "remove-member",
                "id and userId are required",
            );
        }
        return T\MemberRemoved::fromArray(
            $this->t->call(
                "remove-member",
                "DELETE",
                "/v1/me/projects/" .
                    self::seg($id) .
                    "/members/" .
                    self::seg($userId),
            ),
        );
    }

    public function removeProjectMemberByUsername(
        string $id,
        string $username,
    ): T\MemberRemoved {
        if (self::blank($id) || self::blank($username)) {
            throw new NovamemException(
                "remove-member",
                "id and username are required",
            );
        }
        foreach ($this->listProjectMembers($id)->members as $m) {
            if ($m->username === $username && !self::blank($m->userId)) {
                return $this->removeProjectMember($id, (string) $m->userId);
            }
        }
        throw new NovamemException(
            "remove-member",
            "unknown member '$username'",
        );
    }

    public function activeProject(): T\ActiveProject
    {
        return T\ActiveProject::fromArray(
            $this->t->call("active-project", "GET", "/v1/me/active-project"),
        );
    }

    public function setActiveProject(string $project): T\ActiveProject
    {
        if (self::blank($project)) {
            throw new NovamemException(
                "set-active-project",
                "project is required",
            );
        }
        return T\ActiveProject::fromArray(
            $this->t->call(
                "set-active-project",
                "PUT",
                "/v1/me/active-project",
                ["project" => $project],
            ),
        );
    }

    public function clearActiveProject(): void
    {
        $this->t->call(
            "clear-active-project",
            "DELETE",
            "/v1/me/active-project",
            expectBody: false,
        );
    }

    public function decay(?int $effectiveDays = null): T\DecayResult
    {
        return T\DecayResult::fromArray(
            $this->t->call(
                "decay",
                "POST",
                "/v1/decay",
                (object) self::compact(["effectiveDays" => $effectiveDays]),
            ),
        );
    }

    public function hygiene(?int $k = null): T\HygieneReport
    {
        return T\HygieneReport::fromArray(
            $this->t->call(
                "hygiene",
                "POST",
                "/v1/hygiene",
                (object) self::compact(["k" => $k]),
            ),
        );
    }

    public function evaluate(?string $suite = null): T\EvaluateReport
    {
        return T\EvaluateReport::fromArray(
            $this->t->call(
                "evaluate",
                "POST",
                "/v1/evaluate",
                (object) self::compact(["suite" => $suite]),
            ),
        );
    }

    public function adoption(?string $client = null): T\AdoptionReport
    {
        return T\AdoptionReport::fromArray(
            $this->t->call(
                "adoption",
                "POST",
                "/v1/adoption",
                (object) self::compact(["client" => $client]),
            ),
        );
    }

    /**
     * Throws a NovamemException with code "observer_disabled" when the
     * server's observer is off — a configuration answer, not an outage.
     */
    public function observe(
        ?string $project = null,
        ?int $limit = null,
    ): T\ObserveResult {
        try {
            return T\ObserveResult::fromArray(
                $this->t->call(
                    "observe",
                    "POST",
                    "/v1/observe",
                    (object) self::compact([
                        "project" => $project,
                        "limit" => $limit,
                    ]),
                ),
            );
        } catch (NovamemException $e) {
            if ($e->statusCode() === 503) {
                throw new NovamemException(
                    "observe",
                    "observer disabled",
                    503,
                    "observer_disabled",
                );
            }
            throw $e;
        }
    }

    public function changes(
        ?string $since = null,
        ?int $afterSeq = null,
        ?int $limit = null,
    ): T\ChangeFeed {
        $since = $since === null ? null : T\Wire::timestamp($since);
        return T\ChangeFeed::fromArray(
            $this->t->call(
                "changes",
                "GET",
                "/v1/me/changes",
                query: [
                    "since" => $since,
                    "afterSeq" => $afterSeq,
                    "limit" => $limit,
                ],
            ),
        );
    }

    public function usage(): T\Usage
    {
        return T\Usage::fromArray(
            $this->t->call("usage", "GET", "/v1/me/usage"),
        );
    }

    /** One page, oldest first. Pass nextAfterId back as $afterId until a page comes back with no entries. */
    public function export(
        ?string $afterId = null,
        ?int $limit = null,
    ): T\ExportPage {
        return T\ExportPage::fromArray(
            $this->t->call(
                "export",
                "GET",
                "/v1/me/export",
                query: ["afterId" => $afterId, "limit" => $limit],
            ),
        );
    }

    /**
     * Store 1-200 entries (an export page's entries fit as-is),
     * unconditionally, deduplicated by content hash.
     *
     * @param array<array<string, mixed>|object> $entries Any keys are dropped: the entries go out as a JSON array
     */
    public function import(array $entries): T\ImportResult
    {
        if ($entries === []) {
            throw new NovamemException("import", "entries are required");
        }
        $items = array_map(function ($e) {
            $a =
                is_object($e) && method_exists($e, "toArray")
                    ? $e->toArray()
                    : (array) $e;
            // json_decode turns {} into []; metadata must go back as an object.
            if (array_key_exists("metadata", $a) && $a["metadata"] === []) {
                $a["metadata"] = new \stdClass();
            }
            return $a;
        }, array_values($entries));
        return T\ImportResult::fromArray(
            $this->t->call("import", "POST", "/v1/me/import", [
                "entries" => $items,
            ]),
        );
    }
}
