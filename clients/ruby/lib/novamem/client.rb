# frozen_string_literal: true

require "erb"
require "time"

module Novamem
  # Shared by Client, Management and Admin: the transport, and the local
  # checks that stop a malformed call before it leaves the process.
  class Base
    # base_url is the service root; token is the user's nm_ bearer. Nothing
    # is read from the environment. Safe to share across threads.
    def initialize(base_url, token, timeout: DEFAULT_TIMEOUT)
      @t = Transport.new(base_url, token, timeout: timeout)
    end

    def inspect = "#<#{self.class.name} base_url=#{@t.base_url.inspect} token=[redacted]>"

    private

    def seg(s) = ERB::Util.url_encode(s.to_s)

    def blank?(s) = s.to_s.strip.empty?

    def compact(h) = h.reject { |_, v| v.nil? || v == "" }

    def call(...) = @t.call(...)

    # A degraded answer with no results is an outage wearing the costume of
    # an empty result set. A degraded answer WITH results is real data.
    def degraded_empty!(op, body)
      return unless body.is_a?(Hash) && body["degraded"] && Array(body["results"]).empty?

      raise Error.new(op, "store answered degraded with no results, so this is not evidence of absence",
                      status_code: 200, unavailable: true, retryable: true)
    end
  end

  # The data-plane operations an agent needs. Project and token
  # administration live on Management and Admin, so an agent holding a
  # Client cannot perform them by accident.
  class Client < Base
    # Durable write with semantic dedup, in-place update and supersession.
    # A declined worthiness gate is not an error: check result.id.
    def capture(request)
      raise Error.new("capture", "content is required") if blank?(request.content)

      CaptureResult.from_h(call("capture", "POST", "/v1/capture", body: request.to_h_wire))
    end

    def search(request)
      raise Error.new("search", "query is required") if blank?(request.query)

      body = call("search", "POST", "/v1/search", body: request.to_h_wire)
      degraded_empty!("search", body)
      SearchResult.from_h(body)
    end

    def recent(request = RecentRequest.new)
      body = call("recent", "POST", "/v1/recent", body: request.to_h_wire)
      degraded_empty!("recent", body)
      EntryList.from_h(body)
    end

    # #recent over the last 24 hours.
    def today(request = RecentRequest.new)
      recent(request.dup.tap { |r| r.since = Time.now.utc - (24 * 3600) })
    end

    def neighbors(request)
      raise Error.new("neighbors", "id is required") if blank?(request.id)

      body = call("neighbors", "POST", "/v1/neighbors", body: request.to_h_wire)
      degraded_empty!("neighbors", body)
      SearchResult.from_h(body)
    end

    # Rewrite an entry in place, preserving its id, hits and edges.
    def update(id, request = UpdateRequest.new)
      raise Error.new("update", "id is required") if blank?(id)

      body = call("update", "PUT", "/v1/memories/#{seg(id.strip)}", body: request.to_h_wire)
      body = body.merge("id" => id.strip) if body.is_a?(Hash) && blank?(body["id"])
      UpdateResult.from_h(body)
    end

    # Never reports success on a failed delete. An id that is not in your
    # scope comes back deleted: false with no error.
    def forget(request)
      raise Error.new("forget", "id is required") if blank?(request.id)

      ForgetResult.from_h(call("forget", "POST", "/v1/forget", body: request.to_h_wire))
    rescue Error => e
      raise unless e.not_found?

      ForgetResult.new(deleted: false, cold_delete_ok: true)
    end

    # Unconditional store: no worthiness gate, no dedup pass.
    def remember(request)
      raise Error.new("remember", "content is required") if blank?(request.content)

      RememberResult.from_h(call("remember", "POST", "/v1/remember", body: request.to_h_wire))
    end

    def context(request)
      raise Error.new("context", "message is required") if blank?(request.message)

      SearchResult.from_h(call("context", "POST", "/v1/context", body: request.to_h_wire))
    end

    def session_recap(request)
      SessionRecapResult.from_h(call("session-recap", "POST", "/v1/session-recap", body: request.to_h_wire))
    end

    # A not-found error here means the server's observer is disabled.
    def context_prefix(project: nil)
      ContextPrefix.from_h(call("context-prefix", "GET", "/v1/context-prefix", query: { project: project }))
    end

    def stats = Stats.from_h(call("stats", "GET", "/v1/stats"))

    # A served {"ok": false} — including /health's own 503 — is an answer
    # ("not healthy"), not an outage.
    def health
      body = call("health", "GET", "/health")
      body.is_a?(Hash) && body["ok"] == true
    rescue Error => e
      raise unless e.status_code == 503

      false
    end
  end

  # The caller's own /v1/me/* surface: tokens, projects and members, the
  # active project, and the maintenance endpoints.
  class Management < Base
    def mint_token(request = MintTokenRequest.new)
      MintedToken.from_h(call("mint-token", "POST", "/v1/me/tokens", body: request.to_h_wire))
    end

    def list_tokens = TokenList.from_h(call("list-tokens", "GET", "/v1/me/tokens"))

    def revoke_token(hash)
      raise Error.new("revoke-token", "tokenHash is required") if blank?(hash)

      TokenDeleted.from_h(call("revoke-token", "DELETE", "/v1/me/tokens/#{seg(hash.strip)}"))
    end

    def list_projects = ProjectList.from_h(call("list-projects", "GET", "/v1/me/projects"))

    def create_project(name)
      raise Error.new("create-project", "name is required") if blank?(name)

      Project.from_h(call("create-project", "POST", "/v1/me/projects", body: { "name" => name }))
    end

    def delete_project(id)
      raise Error.new("delete-project", "id is required") if blank?(id)

      ProjectDeleted.from_h(call("delete-project", "DELETE", "/v1/me/projects/#{seg(id)}"))
    end

    def list_project_members(id)
      raise Error.new("list-members", "id is required") if blank?(id)

      MemberList.from_h(call("list-members", "GET", "/v1/me/projects/#{seg(id)}/members"))
    end

    # Adds a user by their EXACT sign-in email (the wire field is named
    # "username" for historical reasons). role is "member" or "owner".
    def add_project_member(id, email, role: nil)
      raise Error.new("add-member", "id and email are required") if blank?(id) || blank?(email)

      body = compact("username" => email, "role" => role)
      MemberAdded.from_h(call("add-member", "POST", "/v1/me/projects/#{seg(id)}/members", body: body))
    end

    def remove_project_member(id, user_id)
      raise Error.new("remove-member", "id and userId are required") if blank?(id) || blank?(user_id)

      MemberRemoved.from_h(call("remove-member", "DELETE", "/v1/me/projects/#{seg(id)}/members/#{seg(user_id)}"))
    end

    def remove_project_member_by_username(id, username)
      raise Error.new("remove-member", "id and username are required") if blank?(id) || blank?(username)

      m = Array(list_project_members(id).members).find { |x| x.username == username && x.user_id }
      raise Error.new("remove-member", "unknown member '#{username}'") unless m

      remove_project_member(id, m.user_id)
    end

    def active_project = ActiveProject.from_h(call("active-project", "GET", "/v1/me/active-project"))

    def set_active_project(project)
      raise Error.new("set-active-project", "project is required") if blank?(project)

      ActiveProject.from_h(call("set-active-project", "PUT", "/v1/me/active-project", body: { "project" => project }))
    end

    def clear_active_project
      call("clear-active-project", "DELETE", "/v1/me/active-project", expect_body: false)
      nil
    end

    def decay(effective_days: nil)
      DecayResult.from_h(call("decay", "POST", "/v1/decay", body: compact("effectiveDays" => effective_days)))
    end

    def hygiene(k: nil) = HygieneReport.from_h(call("hygiene", "POST", "/v1/hygiene", body: compact("k" => k)))

    def evaluate(suite: nil)
      EvaluateReport.from_h(call("evaluate", "POST", "/v1/evaluate", body: compact("suite" => suite)))
    end

    def adoption(client: nil)
      AdoptionReport.from_h(call("adoption", "POST", "/v1/adoption", body: compact("client" => client)))
    end

    # Raises an Error with code "observer_disabled" when the server's
    # observer is off — a configuration answer, not an outage.
    def observe(project: nil, limit: nil)
      ObserveResult.from_h(call("observe", "POST", "/v1/observe", body: compact("project" => project, "limit" => limit)))
    rescue Error => e
      raise unless e.status_code == 503

      raise Error.new("observe", "observer disabled", status_code: 503, code: "observer_disabled")
    end

    def changes(since: nil, after_seq: nil, limit: nil)
      since = Wire.timestamp(since) unless since.nil?
      ChangeFeed.from_h(call("changes", "GET", "/v1/me/changes",
                             query: { since: since, afterSeq: after_seq, limit: limit }))
    end

    def usage = Usage.from_h(call("usage", "GET", "/v1/me/usage"))

    # One page, oldest first. Pass next_after_id back as after_id until a
    # page comes back with no entries.
    def export(after_id: nil, limit: nil)
      ExportPage.from_h(call("export", "GET", "/v1/me/export", query: { afterId: after_id, limit: limit }))
    end

    # Store 1-200 entries (an export page's entries fit as-is),
    # unconditionally, deduplicated by content hash.
    def import(entries)
      items = Array(entries).map { |e| e.respond_to?(:to_h_wire) ? e.to_h_wire : e.to_h }
      raise Error.new("import", "entries are required") if items.empty?

      ImportResult.from_h(call("import", "POST", "/v1/me/import", body: { "entries" => items }))
    end
  end

  # Server administration, with an admin user's bearer: provisioning one
  # novamem user per agent, and revoking leaked tokens.
  class Admin < Base
    def provision_user(request)
      raise Error.new("provision-user", "email and password are required") if blank?(request.email) || request.password.to_s.empty?

      ProvisionedUser.from_h(call("provision-user", "POST", "/v1/admin/users", body: request.to_h_wire))
    end

    # Revoke a bearer by presenting its plaintext.
    def revoke_user_token(token)
      raise Error.new("revoke-user-token", "token is required") if blank?(token)

      RevokeResult.from_h(call("revoke-user-token", "POST", "/v1/admin/tokens/revoke", body: { "token" => token }))
    end

    def list_users = AdminUserList.from_h(call("list-users", "GET", "/v1/admin/users"))

    def preview_delete_user(id)
      raise Error.new("preview-delete-user", "userID is required") if blank?(id)

      UserDeletionPreview.from_h(call("preview-delete-user", "DELETE", "/v1/admin/users/#{seg(id)}",
                                      query: { dryRun: "true" }))
    end

    def delete_user(id)
      raise Error.new("delete-user", "userID is required") if blank?(id)

      UserDeletion.from_h(call("delete-user", "DELETE", "/v1/admin/users/#{seg(id)}"))
    end

    # nil clears that override (it is sent as JSON null).
    def set_user_quota(id, max_entries: nil, writes_per_minute: nil)
      raise Error.new("set-user-quota", "userID is required") if blank?(id)

      body = { "maxEntries" => max_entries, "writesPerMinute" => writes_per_minute }
      QuotaResult.from_h(call("set-user-quota", "PUT", "/v1/admin/users/#{seg(id)}/quota", body: body))
    end
  end
end
