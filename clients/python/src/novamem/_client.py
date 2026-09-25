"""Client, Management and Admin: the 41 operations, each a thin call through
the one transport. Op names, verbs, paths and local validation are
transcribed from clients/go, the reference implementation (ADR 0009)."""

from __future__ import annotations

import dataclasses
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

from . import _types as t
from ._errors import NotFoundError, NovamemError, UnavailableError
from ._transport import DEFAULT_TIMEOUT, Transport


def _seg(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def _blank(s: str | None) -> bool:
    return not (s or "").strip()


def _drop_none(d: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None and v != ""}


def _degraded_empty(op: str, body: Any) -> None:
    # A degraded answer with no results is an outage wearing the costume of
    # an empty result set: it carries no information about what is stored.
    # A degraded answer WITH results is real data and is returned as such.
    if isinstance(body, dict) and body.get("degraded") and not body.get("results"):
        raise UnavailableError(
            op,
            "store answered degraded with no results, so this is not evidence of absence",
            status_code=200,
            retryable=True,
        )


class _Base:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        opener: urllib.request.OpenerDirector | None = None,
    ) -> None:
        """``base_url`` is the service root (``https://novamem.example.com``);
        ``token`` is the user's ``nm_…`` bearer. Nothing is read from the
        environment. Safe to share across threads."""
        self._t = Transport(base_url, token, timeout=timeout, opener=opener)

    def __repr__(self) -> str:
        return f"{type(self).__name__}(base_url={self._t.base_url!r}, token=[redacted])"


class Client(_Base):
    """The data-plane operations an agent needs. Project and token
    administration live on Management and Admin, so an agent holding a
    Client cannot perform them by accident."""

    def capture(self, request: t.CaptureRequest) -> t.CaptureResult:
        """Durable write with semantic dedup, in-place update and
        supersession. A declined worthiness gate is not an error: check
        ``result.id``."""
        if _blank(request.content):
            raise NovamemError("capture", "content is required")
        return t.CaptureResult.from_wire(
            self._t.call("capture", "POST", "/v1/capture", request.to_wire())
        )

    def search(self, request: t.SearchRequest) -> t.SearchResult:
        if _blank(request.query):
            raise NovamemError("search", "query is required")
        body = self._t.call("search", "POST", "/v1/search", request.to_wire())
        _degraded_empty("search", body)
        return t.SearchResult.from_wire(body)

    def recent(self, request: t.RecentRequest | None = None) -> t.EntryList:
        body = self._t.call(
            "recent", "POST", "/v1/recent", (request or t.RecentRequest()).to_wire()
        )
        _degraded_empty("recent", body)
        return t.EntryList.from_wire(body)

    def today(self, request: t.RecentRequest | None = None) -> t.EntryList:
        """``recent`` over the last 24 hours."""
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        return self.recent(
            dataclasses.replace(request or t.RecentRequest(), since=since)
        )

    def neighbors(self, request: t.NeighborsRequest) -> t.SearchResult:
        if _blank(request.id):
            raise NovamemError("neighbors", "id is required")
        body = self._t.call("neighbors", "POST", "/v1/neighbors", request.to_wire())
        _degraded_empty("neighbors", body)
        return t.SearchResult.from_wire(body)

    def update(self, id: str, request: t.UpdateRequest | None = None) -> t.UpdateResult:
        """Rewrite an entry in place, preserving its id, hits and edges."""
        if _blank(id):
            raise NovamemError("update", "id is required")
        body = self._t.call(
            "update",
            "PUT",
            "/v1/memories/" + _seg(id.strip()),
            (request or t.UpdateRequest()).to_wire(),
        )
        if isinstance(body, dict) and not body.get("id"):
            body = {**body, "id": id.strip()}
        return t.UpdateResult.from_wire(body)

    def forget(self, request: t.ForgetRequest) -> t.ForgetResult:
        """Never reports success on a failed delete. An id that is not in
        your scope comes back ``deleted=False`` with no error."""
        if _blank(request.id):
            raise NovamemError("forget", "id is required")
        try:
            body = self._t.call("forget", "POST", "/v1/forget", request.to_wire())
        except NotFoundError:
            return t.ForgetResult(deleted=False, cold_delete_ok=True)
        return t.ForgetResult.from_wire(body)

    def remember(self, request: t.CaptureRequest) -> t.RememberResult:
        """Unconditional store: no worthiness gate, no dedup pass."""
        if _blank(request.content):
            raise NovamemError("remember", "content is required")
        return t.RememberResult.from_wire(
            self._t.call("remember", "POST", "/v1/remember", request.to_wire())
        )

    def context(self, request: t.ContextRequest) -> t.SearchResult:
        if _blank(request.message):
            raise NovamemError("context", "message is required")
        return t.SearchResult.from_wire(
            self._t.call("context", "POST", "/v1/context", request.to_wire())
        )

    def session_recap(self, request: t.SessionRecapRequest) -> t.SessionRecapResult:
        return t.SessionRecapResult.from_wire(
            self._t.call(
                "session-recap", "POST", "/v1/session-recap", request.to_wire()
            )
        )

    def context_prefix(self, project: str | None = None) -> t.ContextPrefix:
        """A NotFoundError here means the server's observer is disabled."""
        return t.ContextPrefix.from_wire(
            self._t.call(
                "context-prefix",
                "GET",
                "/v1/context-prefix",
                query={"project": project},
            )
        )

    def stats(self) -> t.Stats:
        return t.Stats.from_wire(self._t.call("stats", "GET", "/v1/stats"))

    def health(self) -> bool:
        """A served ``{"ok": false}`` — including /health's own 503 — is an
        answer ("not healthy"), not an outage."""
        try:
            body = self._t.call("health", "GET", "/health")
        except UnavailableError as e:
            if e.status_code == 503:
                return False
            raise
        return bool(isinstance(body, dict) and body.get("ok"))


class Management(_Base):
    """The caller's own /v1/me/* surface: tokens, projects and members, the
    active project, and the maintenance endpoints."""

    def mint_token(self, request: t.MintTokenRequest | None = None) -> t.MintedToken:
        return t.MintedToken.from_wire(
            self._t.call(
                "mint-token",
                "POST",
                "/v1/me/tokens",
                (request or t.MintTokenRequest()).to_wire(),
            )
        )

    def list_tokens(self) -> t.TokenList:
        return t.TokenList.from_wire(
            self._t.call("list-tokens", "GET", "/v1/me/tokens")
        )

    def revoke_token(self, hash: str) -> t.TokenDeleted:
        if _blank(hash):
            raise NovamemError("revoke-token", "tokenHash is required")
        return t.TokenDeleted.from_wire(
            self._t.call(
                "revoke-token", "DELETE", "/v1/me/tokens/" + _seg(hash.strip())
            )
        )

    def list_projects(self) -> t.ProjectList:
        return t.ProjectList.from_wire(
            self._t.call("list-projects", "GET", "/v1/me/projects")
        )

    def create_project(self, name: str) -> t.Project:
        if _blank(name):
            raise NovamemError("create-project", "name is required")
        return t.Project.from_wire(
            self._t.call("create-project", "POST", "/v1/me/projects", {"name": name})
        )

    def delete_project(self, id: str) -> t.ProjectDeleted:
        if _blank(id):
            raise NovamemError("delete-project", "id is required")
        return t.ProjectDeleted.from_wire(
            self._t.call("delete-project", "DELETE", "/v1/me/projects/" + _seg(id))
        )

    def list_project_members(self, id: str) -> t.MemberList:
        if _blank(id):
            raise NovamemError("list-members", "id is required")
        return t.MemberList.from_wire(
            self._t.call(
                "list-members", "GET", "/v1/me/projects/" + _seg(id) + "/members"
            )
        )

    def add_project_member(
        self, id: str, email: str, role: str | None = None
    ) -> t.MemberAdded:
        """Adds a user by their EXACT sign-in email (the wire field is named
        "username" for historical reasons). ``role`` is "member" or "owner"."""
        if _blank(id) or _blank(email):
            raise NovamemError("add-member", "id and email are required")
        return t.MemberAdded.from_wire(
            self._t.call(
                "add-member",
                "POST",
                "/v1/me/projects/" + _seg(id) + "/members",
                _drop_none({"username": email, "role": role}),
            )
        )

    def remove_project_member(self, id: str, user_id: str) -> t.MemberRemoved:
        if _blank(id) or _blank(user_id):
            raise NovamemError("remove-member", "id and userId are required")
        return t.MemberRemoved.from_wire(
            self._t.call(
                "remove-member",
                "DELETE",
                "/v1/me/projects/" + _seg(id) + "/members/" + _seg(user_id),
            )
        )

    def remove_project_member_by_username(
        self, id: str, username: str
    ) -> t.MemberRemoved:
        if _blank(id) or _blank(username):
            raise NovamemError("remove-member", "id and username are required")
        for m in self.list_project_members(id).members:
            if m.username == username and m.user_id:
                return self.remove_project_member(id, m.user_id)
        raise NovamemError("remove-member", f"unknown member '{username}'")

    def active_project(self) -> t.ActiveProject:
        return t.ActiveProject.from_wire(
            self._t.call("active-project", "GET", "/v1/me/active-project")
        )

    def set_active_project(self, project: str) -> t.ActiveProject:
        if _blank(project):
            raise NovamemError("set-active-project", "project is required")
        return t.ActiveProject.from_wire(
            self._t.call(
                "set-active-project",
                "PUT",
                "/v1/me/active-project",
                {"project": project},
            )
        )

    def clear_active_project(self) -> None:
        self._t.call(
            "clear-active-project", "DELETE", "/v1/me/active-project", expect_body=False
        )

    def decay(self, effective_days: int | None = None) -> t.DecayResult:
        return t.DecayResult.from_wire(
            self._t.call(
                "decay",
                "POST",
                "/v1/decay",
                _drop_none({"effectiveDays": effective_days}),
            )
        )

    def hygiene(self, k: int | None = None) -> t.HygieneReport:
        return t.HygieneReport.from_wire(
            self._t.call("hygiene", "POST", "/v1/hygiene", _drop_none({"k": k}))
        )

    def evaluate(self, suite: str | None = None) -> t.EvaluateReport:
        return t.EvaluateReport.from_wire(
            self._t.call(
                "evaluate", "POST", "/v1/evaluate", _drop_none({"suite": suite})
            )
        )

    def adoption(self, client: str | None = None) -> t.AdoptionReport:
        return t.AdoptionReport.from_wire(
            self._t.call(
                "adoption", "POST", "/v1/adoption", _drop_none({"client": client})
            )
        )

    def observe(
        self, project: str | None = None, limit: int | None = None
    ) -> t.ObserveResult:
        """Raises NovamemError with code "observer_disabled" when the
        server's observer is off — a configuration answer, not an outage."""
        try:
            body = self._t.call(
                "observe",
                "POST",
                "/v1/observe",
                _drop_none({"project": project, "limit": limit}),
            )
        except UnavailableError as e:
            if e.status_code == 503:
                raise NovamemError(
                    "observe",
                    "observer disabled",
                    status_code=503,
                    code="observer_disabled",
                ) from None
            raise
        return t.ObserveResult.from_wire(body)

    def changes(
        self,
        since: str | None = None,
        after_seq: int | None = None,
        limit: int | None = None,
    ) -> t.ChangeFeed:
        return t.ChangeFeed.from_wire(
            self._t.call(
                "changes",
                "GET",
                "/v1/me/changes",
                query={"since": since, "afterSeq": after_seq, "limit": limit},
            )
        )

    def usage(self) -> t.Usage:
        return t.Usage.from_wire(self._t.call("usage", "GET", "/v1/me/usage"))

    def export(
        self, after_id: str | None = None, limit: int | None = None
    ) -> t.ExportPage:
        """One page, oldest first. Pass ``next_after_id`` back as
        ``after_id`` until a page comes back with no entries."""
        return t.ExportPage.from_wire(
            self._t.call(
                "export",
                "GET",
                "/v1/me/export",
                query={"afterId": after_id, "limit": limit},
            )
        )

    def import_(self, entries: Iterable[Mapping[str, Any]]) -> t.ImportResult:
        """Store 1-200 entries (an export page's ``entries`` fit as-is),
        unconditionally, deduplicated by content hash."""
        items = [
            dict(e.to_wire()) if hasattr(e, "to_wire") else dict(e)
            for e in (entries or [])
        ]
        if not items:
            raise NovamemError("import", "entries are required")
        return t.ImportResult.from_wire(
            self._t.call("import", "POST", "/v1/me/import", {"entries": items})
        )


class Admin(_Base):
    """Server administration, with an admin user's bearer: provisioning one
    novamem user per agent, and revoking leaked tokens."""

    def provision_user(self, request: t.ProvisionUserRequest) -> t.ProvisionedUser:
        if _blank(request.email) or not request.password:
            raise NovamemError("provision-user", "email and password are required")
        return t.ProvisionedUser.from_wire(
            self._t.call("provision-user", "POST", "/v1/admin/users", request.to_wire())
        )

    def revoke_user_token(self, token: str) -> t.RevokeResult:
        """Revoke a bearer by presenting its plaintext."""
        if _blank(token):
            raise NovamemError("revoke-user-token", "token is required")
        return t.RevokeResult.from_wire(
            self._t.call(
                "revoke-user-token", "POST", "/v1/admin/tokens/revoke", {"token": token}
            )
        )

    def list_users(self) -> t.AdminUserList:
        return t.AdminUserList.from_wire(
            self._t.call("list-users", "GET", "/v1/admin/users")
        )

    def preview_delete_user(self, id: str) -> t.UserDeletionPreview:
        if _blank(id):
            raise NovamemError("preview-delete-user", "userID is required")
        return t.UserDeletionPreview.from_wire(
            self._t.call(
                "preview-delete-user",
                "DELETE",
                "/v1/admin/users/" + _seg(id),
                query={"dryRun": True},
            )
        )

    def delete_user(self, id: str) -> t.UserDeletion:
        if _blank(id):
            raise NovamemError("delete-user", "userID is required")
        return t.UserDeletion.from_wire(
            self._t.call("delete-user", "DELETE", "/v1/admin/users/" + _seg(id))
        )

    def set_user_quota(
        self,
        id: str,
        max_entries: int | None = None,
        writes_per_minute: int | None = None,
    ) -> t.QuotaResult:
        """None clears that override (it is sent as JSON null)."""
        if _blank(id):
            raise NovamemError("set-user-quota", "userID is required")
        return t.QuotaResult.from_wire(
            self._t.call(
                "set-user-quota",
                "PUT",
                "/v1/admin/users/" + _seg(id) + "/quota",
                {"maxEntries": max_entries, "writesPerMinute": writes_per_minute},
            )
        )
