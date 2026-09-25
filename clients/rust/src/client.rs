//! `Client`, `Management` and `Admin`: the 41 operations, each a thin call
//! through the one transport. Op names, verbs, paths and local validation
//! are transcribed from clients/go, the reference implementation (ADR 0009).

use std::time::{Duration, SystemTime};

use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::transport::{Call, Transport};
use crate::{time, types as t, Config, Error};

fn seg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn blank(s: &str) -> bool {
    s.trim().is_empty()
}

fn body<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// An object of the given fields, leaving out unset and empty ones.
fn fields(pairs: &[(&str, Value)]) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        match v {
            Value::Null => {}
            Value::String(s) if s.is_empty() => {}
            _ => {
                m.insert((*k).to_string(), v.clone());
            }
        }
    }
    Value::Object(m)
}

fn decode<T: DeserializeOwned>(op: &str, v: Value) -> Result<T, Error> {
    serde_json::from_value(v)
        .map_err(|e| Error::unavailable(op, format!("malformed response body: {e}"), false))
}

/// A degraded answer with no results is an outage wearing the costume of an
/// empty result set. A degraded answer WITH results is real data.
fn degraded_empty(op: &str, v: &Value) -> Result<(), Error> {
    let degraded = v.get("degraded").and_then(Value::as_bool).unwrap_or(false);
    let empty = v
        .get("results")
        .and_then(Value::as_array)
        .map_or(true, |r| r.is_empty());
    if degraded && empty {
        return Err(Error::unavailable(
            op,
            "store answered degraded with no results, so this is not evidence of absence",
            true,
        )
        .with_status(200));
    }
    Ok(())
}

macro_rules! handle {
    ($(#[$m:meta])* $name:ident) => {
        $(#[$m])*
        #[derive(Clone, Debug)]
        pub struct $name {
            t: Transport,
        }

        impl $name {
            /// Validates the configuration: a missing or non-absolute base
            /// URL, or a blank token, fails here rather than on every call.
            pub fn new(cfg: Config) -> Result<Self, Error> {
                Ok($name { t: Transport::new(cfg)? })
            }
        }
    };
}

handle!(
    /// The data-plane operations an agent needs. Project and token
    /// administration live on [`Management`] and [`Admin`], so an agent
    /// holding a `Client` cannot perform them by accident.
    Client
);
handle!(
    /// The caller's own /v1/me/* surface: tokens, projects and members, the
    /// active project, and the maintenance endpoints.
    Management
);
handle!(
    /// Server administration, with an admin user's bearer.
    Admin
);

impl Client {
    /// Durable write with semantic dedup, in-place update and supersession.
    /// A declined worthiness gate is not an error: check `result.id`.
    pub async fn capture(&self, request: t::CaptureRequest) -> Result<t::CaptureResult, Error> {
        if blank(&request.content) {
            return Err(Error::new("capture", "content is required"));
        }
        let v = self
            .t
            .call(Call::new("capture", Method::POST, "/v1/capture").body(body(&request)))
            .await?;
        decode("capture", v)
    }

    pub async fn search(&self, request: t::SearchRequest) -> Result<t::SearchResult, Error> {
        if blank(&request.query) {
            return Err(Error::new("search", "query is required"));
        }
        let v = self
            .t
            .call(Call::new("search", Method::POST, "/v1/search").body(body(&request)))
            .await?;
        degraded_empty("search", &v)?;
        decode("search", v)
    }

    pub async fn recent(&self, request: t::RecentRequest) -> Result<t::EntryList, Error> {
        let v = self
            .t
            .call(Call::new("recent", Method::POST, "/v1/recent").body(body(&request)))
            .await?;
        degraded_empty("recent", &v)?;
        decode("recent", v)
    }

    /// [`Client::recent`] over the last 24 hours.
    pub async fn today(&self, request: t::RecentRequest) -> Result<t::EntryList, Error> {
        let since = time::rfc3339(SystemTime::now() - Duration::from_secs(24 * 3600));
        self.recent(t::RecentRequest {
            since: Some(since),
            ..request
        })
        .await
    }

    pub async fn neighbors(&self, request: t::NeighborsRequest) -> Result<t::SearchResult, Error> {
        if blank(&request.id) {
            return Err(Error::new("neighbors", "id is required"));
        }
        let v = self
            .t
            .call(Call::new("neighbors", Method::POST, "/v1/neighbors").body(body(&request)))
            .await?;
        degraded_empty("neighbors", &v)?;
        decode("neighbors", v)
    }

    /// Rewrite an entry in place, preserving its id, hits and edges.
    pub async fn update(
        &self,
        id: &str,
        request: t::UpdateRequest,
    ) -> Result<t::UpdateResult, Error> {
        if blank(id) {
            return Err(Error::new("update", "id is required"));
        }
        let path = format!("/v1/memories/{}", seg(id.trim()));
        let mut v = self
            .t
            .call(Call::new("update", Method::PUT, path).body(body(&request)))
            .await?;
        if v.get("id")
            .and_then(Value::as_str)
            .map_or(true, str::is_empty)
        {
            if let Value::Object(m) = &mut v {
                m.insert("id".into(), json!(id.trim()));
            }
        }
        decode("update", v)
    }

    /// Never reports success on a failed delete. An id that is not in your
    /// scope comes back `deleted: false` with no error.
    pub async fn forget(&self, request: t::ForgetRequest) -> Result<t::ForgetResult, Error> {
        if blank(&request.id) {
            return Err(Error::new("forget", "id is required"));
        }
        match self
            .t
            .call(Call::new("forget", Method::POST, "/v1/forget").body(body(&request)))
            .await
        {
            Ok(v) => decode("forget", v),
            Err(e) if e.is_not_found() => Ok(t::ForgetResult {
                deleted: false,
                cold_delete_ok: Some(true),
            }),
            Err(e) => Err(e),
        }
    }

    /// Unconditional store: no worthiness gate, no dedup pass.
    pub async fn remember(&self, request: t::CaptureRequest) -> Result<t::RememberResult, Error> {
        if blank(&request.content) {
            return Err(Error::new("remember", "content is required"));
        }
        let v = self
            .t
            .call(Call::new("remember", Method::POST, "/v1/remember").body(body(&request)))
            .await?;
        decode("remember", v)
    }

    pub async fn context(&self, request: t::ContextRequest) -> Result<t::SearchResult, Error> {
        if blank(&request.message) {
            return Err(Error::new("context", "message is required"));
        }
        let v = self
            .t
            .call(Call::new("context", Method::POST, "/v1/context").body(body(&request)))
            .await?;
        decode("context", v)
    }

    pub async fn session_recap(
        &self,
        request: t::SessionRecapRequest,
    ) -> Result<t::SessionRecapResult, Error> {
        let v = self
            .t
            .call(
                Call::new("session-recap", Method::POST, "/v1/session-recap").body(body(&request)),
            )
            .await?;
        decode("session-recap", v)
    }

    /// A not-found error here means the server's observer is disabled.
    pub async fn context_prefix(&self, project: Option<&str>) -> Result<t::ContextPrefix, Error> {
        let v = self
            .t
            .call(
                Call::new("context-prefix", Method::GET, "/v1/context-prefix")
                    .query("project", project),
            )
            .await?;
        decode("context-prefix", v)
    }

    pub async fn stats(&self) -> Result<t::Stats, Error> {
        let v = self
            .t
            .call(Call::new("stats", Method::GET, "/v1/stats"))
            .await?;
        decode("stats", v)
    }

    /// A served `{"ok": false}` — including /health's own 503 — is an
    /// answer ("not healthy"), not an outage.
    pub async fn health(&self) -> Result<bool, Error> {
        match self
            .t
            .call(Call::new("health", Method::GET, "/health"))
            .await
        {
            Ok(v) => Ok(v.get("ok").and_then(Value::as_bool).unwrap_or(false)),
            Err(e) if e.status() == 503 => Ok(false),
            Err(e) => Err(e),
        }
    }
}

impl Management {
    pub async fn mint_token(&self, request: t::MintTokenRequest) -> Result<t::MintedToken, Error> {
        let v = self
            .t
            .call(Call::new("mint-token", Method::POST, "/v1/me/tokens").body(body(&request)))
            .await?;
        decode("mint-token", v)
    }

    pub async fn list_tokens(&self) -> Result<t::TokenList, Error> {
        let v = self
            .t
            .call(Call::new("list-tokens", Method::GET, "/v1/me/tokens"))
            .await?;
        decode("list-tokens", v)
    }

    pub async fn revoke_token(&self, hash: &str) -> Result<t::TokenDeleted, Error> {
        if blank(hash) {
            return Err(Error::new("revoke-token", "tokenHash is required"));
        }
        let path = format!("/v1/me/tokens/{}", seg(hash.trim()));
        let v = self
            .t
            .call(Call::new("revoke-token", Method::DELETE, path))
            .await?;
        decode("revoke-token", v)
    }

    pub async fn list_projects(&self) -> Result<t::ProjectList, Error> {
        let v = self
            .t
            .call(Call::new("list-projects", Method::GET, "/v1/me/projects"))
            .await?;
        decode("list-projects", v)
    }

    pub async fn create_project(&self, name: &str) -> Result<t::Project, Error> {
        if blank(name) {
            return Err(Error::new("create-project", "name is required"));
        }
        let call = Call::new("create-project", Method::POST, "/v1/me/projects")
            .body(json!({ "name": name }));
        decode("create-project", self.t.call(call).await?)
    }

    pub async fn delete_project(&self, id: &str) -> Result<t::ProjectDeleted, Error> {
        if blank(id) {
            return Err(Error::new("delete-project", "id is required"));
        }
        let v = self
            .t
            .call(Call::new(
                "delete-project",
                Method::DELETE,
                format!("/v1/me/projects/{}", seg(id)),
            ))
            .await?;
        decode("delete-project", v)
    }

    pub async fn list_project_members(&self, id: &str) -> Result<t::MemberList, Error> {
        if blank(id) {
            return Err(Error::new("list-members", "id is required"));
        }
        let path = format!("/v1/me/projects/{}/members", seg(id));
        decode(
            "list-members",
            self.t
                .call(Call::new("list-members", Method::GET, path))
                .await?,
        )
    }

    /// Adds a user by their EXACT sign-in email (the wire field is named
    /// "username" for historical reasons). `role` is "member" or "owner".
    pub async fn add_project_member(
        &self,
        id: &str,
        email: &str,
        role: Option<&str>,
    ) -> Result<t::MemberAdded, Error> {
        if blank(id) || blank(email) {
            return Err(Error::new("add-member", "id and email are required"));
        }
        let path = format!("/v1/me/projects/{}/members", seg(id));
        let b = fields(&[("username", json!(email)), ("role", json!(role))]);
        decode(
            "add-member",
            self.t
                .call(Call::new("add-member", Method::POST, path).body(b))
                .await?,
        )
    }

    pub async fn remove_project_member(
        &self,
        id: &str,
        user_id: &str,
    ) -> Result<t::MemberRemoved, Error> {
        if blank(id) || blank(user_id) {
            return Err(Error::new("remove-member", "id and userId are required"));
        }
        let path = format!("/v1/me/projects/{}/members/{}", seg(id), seg(user_id));
        decode(
            "remove-member",
            self.t
                .call(Call::new("remove-member", Method::DELETE, path))
                .await?,
        )
    }

    pub async fn remove_project_member_by_username(
        &self,
        id: &str,
        username: &str,
    ) -> Result<t::MemberRemoved, Error> {
        if blank(id) || blank(username) {
            return Err(Error::new("remove-member", "id and username are required"));
        }
        let members = self.list_project_members(id).await?.members;
        match members
            .iter()
            .find(|m| m.username.as_deref() == Some(username))
            .and_then(|m| m.user_id.clone())
        {
            Some(user_id) => self.remove_project_member(id, &user_id).await,
            None => Err(Error::new(
                "remove-member",
                format!("unknown member '{username}'"),
            )),
        }
    }

    pub async fn active_project(&self) -> Result<t::ActiveProject, Error> {
        let v = self
            .t
            .call(Call::new(
                "active-project",
                Method::GET,
                "/v1/me/active-project",
            ))
            .await?;
        decode("active-project", v)
    }

    pub async fn set_active_project(&self, project: &str) -> Result<t::ActiveProject, Error> {
        if blank(project) {
            return Err(Error::new("set-active-project", "project is required"));
        }
        let call = Call::new("set-active-project", Method::PUT, "/v1/me/active-project")
            .body(json!({ "project": project }));
        decode("set-active-project", self.t.call(call).await?)
    }

    pub async fn clear_active_project(&self) -> Result<(), Error> {
        self.t
            .call(
                Call::new(
                    "clear-active-project",
                    Method::DELETE,
                    "/v1/me/active-project",
                )
                .no_body(),
            )
            .await?;
        Ok(())
    }

    pub async fn decay(&self, effective_days: Option<i32>) -> Result<t::DecayResult, Error> {
        let b = fields(&[("effectiveDays", json!(effective_days))]);
        decode(
            "decay",
            self.t
                .call(Call::new("decay", Method::POST, "/v1/decay").body(b))
                .await?,
        )
    }

    pub async fn hygiene(&self, k: Option<i32>) -> Result<t::HygieneReport, Error> {
        let b = fields(&[("k", json!(k))]);
        decode(
            "hygiene",
            self.t
                .call(Call::new("hygiene", Method::POST, "/v1/hygiene").body(b))
                .await?,
        )
    }

    pub async fn evaluate(&self, suite: Option<&str>) -> Result<t::EvaluateReport, Error> {
        let b = fields(&[("suite", json!(suite))]);
        decode(
            "evaluate",
            self.t
                .call(Call::new("evaluate", Method::POST, "/v1/evaluate").body(b))
                .await?,
        )
    }

    pub async fn adoption(&self, client: Option<&str>) -> Result<t::AdoptionReport, Error> {
        let b = fields(&[("client", json!(client))]);
        decode(
            "adoption",
            self.t
                .call(Call::new("adoption", Method::POST, "/v1/adoption").body(b))
                .await?,
        )
    }

    /// Fails with code "observer_disabled" when the server's observer is
    /// off — a configuration answer, not an outage.
    pub async fn observe(
        &self,
        project: Option<&str>,
        limit: Option<i32>,
    ) -> Result<t::ObserveResult, Error> {
        let b = fields(&[("project", json!(project)), ("limit", json!(limit))]);
        match self
            .t
            .call(Call::new("observe", Method::POST, "/v1/observe").body(b))
            .await
        {
            Ok(v) => decode("observe", v),
            Err(e) if e.status() == 503 => Err(Error::new("observe", "observer disabled")
                .with_status(503)
                .with_code("observer_disabled")),
            Err(e) => Err(e),
        }
    }

    pub async fn changes(
        &self,
        since: Option<&str>,
        after_seq: Option<i64>,
        limit: Option<i32>,
    ) -> Result<t::ChangeFeed, Error> {
        let call = Call::new("changes", Method::GET, "/v1/me/changes")
            .query("since", since)
            .query("afterSeq", after_seq)
            .query("limit", limit);
        decode("changes", self.t.call(call).await?)
    }

    pub async fn usage(&self) -> Result<t::Usage, Error> {
        decode(
            "usage",
            self.t
                .call(Call::new("usage", Method::GET, "/v1/me/usage"))
                .await?,
        )
    }

    /// One page, oldest first. Pass `next_after_id` back as `after_id` until
    /// a page comes back with no entries.
    pub async fn export(
        &self,
        after_id: Option<&str>,
        limit: Option<i32>,
    ) -> Result<t::ExportPage, Error> {
        let call = Call::new("export", Method::GET, "/v1/me/export")
            .query("afterId", after_id)
            .query("limit", limit);
        decode("export", self.t.call(call).await?)
    }

    /// Store 1-200 entries (an export page's `entries` fit as-is),
    /// unconditionally, deduplicated by content hash.
    pub async fn import(&self, entries: Vec<Value>) -> Result<t::ImportResult, Error> {
        if entries.is_empty() {
            return Err(Error::new("import", "entries are required"));
        }
        let call =
            Call::new("import", Method::POST, "/v1/me/import").body(json!({ "entries": entries }));
        decode("import", self.t.call(call).await?)
    }
}

impl Admin {
    pub async fn provision_user(
        &self,
        request: t::ProvisionUserRequest,
    ) -> Result<t::ProvisionedUser, Error> {
        if blank(&request.email) || request.password.is_empty() {
            return Err(Error::new(
                "provision-user",
                "email and password are required",
            ));
        }
        let v = self
            .t
            .call(Call::new("provision-user", Method::POST, "/v1/admin/users").body(body(&request)))
            .await?;
        decode("provision-user", v)
    }

    /// Revoke a bearer by presenting its plaintext.
    pub async fn revoke_user_token(&self, token: &str) -> Result<t::RevokeResult, Error> {
        if blank(token) {
            return Err(Error::new("revoke-user-token", "token is required"));
        }
        let call = Call::new("revoke-user-token", Method::POST, "/v1/admin/tokens/revoke")
            .body(json!({ "token": token }));
        decode("revoke-user-token", self.t.call(call).await?)
    }

    pub async fn list_users(&self) -> Result<t::AdminUserList, Error> {
        decode(
            "list-users",
            self.t
                .call(Call::new("list-users", Method::GET, "/v1/admin/users"))
                .await?,
        )
    }

    pub async fn preview_delete_user(&self, id: &str) -> Result<t::UserDeletionPreview, Error> {
        if blank(id) {
            return Err(Error::new("preview-delete-user", "userID is required"));
        }
        let call = Call::new(
            "preview-delete-user",
            Method::DELETE,
            format!("/v1/admin/users/{}", seg(id)),
        )
        .query("dryRun", Some("true"));
        decode("preview-delete-user", self.t.call(call).await?)
    }

    pub async fn delete_user(&self, id: &str) -> Result<t::UserDeletion, Error> {
        if blank(id) {
            return Err(Error::new("delete-user", "userID is required"));
        }
        let v = self
            .t
            .call(Call::new(
                "delete-user",
                Method::DELETE,
                format!("/v1/admin/users/{}", seg(id)),
            ))
            .await?;
        decode("delete-user", v)
    }

    /// `None` clears that override (it is sent as JSON null).
    pub async fn set_user_quota(
        &self,
        id: &str,
        max_entries: Option<i32>,
        writes_per_minute: Option<i32>,
    ) -> Result<t::QuotaResult, Error> {
        if blank(id) {
            return Err(Error::new("set-user-quota", "userID is required"));
        }
        let path = format!("/v1/admin/users/{}/quota", seg(id));
        let b = json!({ "maxEntries": max_entries, "writesPerMinute": writes_per_minute });
        decode(
            "set-user-quota",
            self.t
                .call(Call::new("set-user-quota", Method::PUT, path).body(b))
                .await?,
        )
    }
}
