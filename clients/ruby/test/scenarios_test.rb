# frozen_string_literal: true

# The shared behaviour suite (clients/contract/scenarios.json, ADR 0009).

require "minitest/autorun"
require "json"
require "net/http"
require "novamem"
require_relative "dispatch"

CONTRACT = File.expand_path("../../contract", __dir__)
SCEN = JSON.parse(File.read(File.join(CONTRACT, "scenarios.json")))
TOKEN = SCEN.fetch("token")

class ScenariosTest < Minitest::Test
  def self.server
    @server ||= begin
      io = IO.popen(["sh", "scenario-server.sh", "-scenarios", "scenarios.json"], chdir: CONTRACT)
      _, url, closed = io.gets.split
      Minitest.after_run { Process.kill("KILL", io.pid) }
      [url, closed.split("=").last]
    end
  end

  def empty?(r)
    w = r.respond_to?(:to_h_wire) ? r.to_h_wire : r
    w == [] || (w.is_a?(Hash) && w["results"] == [])
  end

  def classify(r, e)
    return (empty?(r) ? "empty" : "ok") if e.nil?
    return "unavailable" if e.is_a?(Novamem::Error) && e.unavailable?
    return "not_found" if e.is_a?(Novamem::Error) && e.not_found?

    "error"
  end

  def subset(want, got, path = "$")
    return (got == want ? nil : "#{path}: got #{got.inspect}, want #{want.inspect}") unless want.is_a?(Hash)
    return "#{path}: want an object, got #{got.inspect}" unless got.is_a?(Hash)

    want.each { |k, v| (d = subset(v, got[k], "#{path}.#{k}")) && (return d) }
    nil
  end

  # proved by: removing the degraded-empty check in Client#search fails
  # search-degraded-empty-is-unavailable; removing the redaction fails
  # token-echoed-in-401-is-redacted.
  SCEN.fetch("scenarios").each do |s|
    define_method("test_#{s["id"].tr("-", "_")}") do
      skip "the Ruby client has no cancellation primitive: #{s["id"]}" if Array(s["requires"]).include?("cancel")
      url, closed = self.class.server
      call = s["call"]
      r = e = nil
      if call["class"] == "ctor"
        begin
          Novamem::Client.new(call["args"]["baseUrl"].sub("<server>", url), call["args"]["token"])
        rescue Novamem::ConfigError, Novamem::Error => err
          e = err
        end
      else
        refused = s["respond"].to_json.include?('"refused"')
        base = refused ? "http://127.0.0.1:#{closed}/s/#{s["id"]}" : "#{url}/s/#{s["id"]}"
        opts = { timeout: SCEN["timeoutMs"] / 1000.0 }
        clients = { Client: Novamem::Client.new(base, TOKEN, **opts),
                    Management: Novamem::Management.new(base, TOKEN, **opts),
                    Admin: Novamem::Admin.new(base, TOKEN, **opts) }
        begin
          r = DISPATCH.fetch(call["method"]).call(clients, call["args"])
        rescue Novamem::Error => err
          e = err
        end
      end
      exp = s["expect"]
      assert_equal exp["outcome"], classify(r, e), "#{s["id"]}: #{e.inspect}"
      if e
        refute_includes e.message, TOKEN
        refute_includes e.inspect, TOKEN
        if e.is_a?(Novamem::Error)
          assert_equal exp["retryable"], e.retryable?, "retryable" if exp.key?("retryable")
          assert_equal exp["statusCode"], e.status_code, "statusCode" if exp.key?("statusCode")
          assert_equal exp["code"], e.code, "code" if exp.key?("code")
        end
        assert_includes e.message.downcase, exp["messageContains"].downcase if exp.key?("messageContains")
      end
      if exp.key?("result")
        got = r.respond_to?(:to_h_wire) ? r.to_h_wire : r
        assert_nil subset(exp["result"], got)
      end
      next if call["class"] == "ctor"

      v = JSON.parse(Net::HTTP.get(URI("#{url}/_verdict/#{s["id"]}")))
      assert_equal [], v["mismatches"]
      assert_equal 0, v["requests"] if s["expectRequest"] == []
    end
  end
end
