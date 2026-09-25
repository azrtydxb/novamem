# frozen_string_literal: true

require "json"
require "net/http"
require "openssl"
require "uri"

module Novamem
  # Bounds each connect, read and write when no timeout is given. Sized for
  # the slowest operation: capture embeds the content before it answers.
  DEFAULT_TIMEOUT = 15

  # Responses larger than this are rejected rather than buffered.
  MAX_RESPONSE_BYTES = 8 << 20

  # One method makes every request, so failures are classified once.
  class Transport
    NETWORK_ERRORS = [SocketError, SystemCallError, IOError, EOFError, OpenSSL::SSL::SSLError,
                      Net::HTTPBadResponse, Net::ProtocolError].freeze

    attr_reader :base_url

    def initialize(base_url, token, timeout: DEFAULT_TIMEOUT)
      base = base_url.to_s.strip.sub(%r{/+\z}, "")
      uri = begin
        URI.parse(base)
      rescue URI::InvalidURIError
        nil
      end
      # Names the field, never the value: a token pasted into the wrong
      # argument must not end up in a log line.
      unless uri.is_a?(URI::HTTP) && !uri.host.to_s.empty?
        raise ConfigError, "novamem: base_url is not an absolute http(s) URL"
      end
      raise ConfigError, "novamem: token is required" if token.to_s.strip.empty?

      @base_url = base
      @token = token
      @timeout = timeout.to_f.positive? ? timeout.to_f : DEFAULT_TIMEOUT
    end

    def inspect = "#<Novamem::Transport base_url=#{@base_url.inspect} token=[redacted]>"

    # Performs one request; returns the decoded JSON body (nil when
    # expect_body is false) or raises Novamem::Error.
    def call(op, method, path, body: nil, query: nil, expect_body: true)
      uri = URI(@base_url + path)
      q = (query || {}).reject { |_, v| v.nil? || v == "" }
      uri.query = URI.encode_www_form(q) unless q.empty?
      status, raw = exchange(op, method, uri, body.nil? ? nil : JSON.generate(body))
      decode(op, status, raw, expect_body)
    end

    private

    def redact(s) = s.to_s.gsub(@token, "[redacted]")

    # Follows up to 5 redirects itself, so the bearer never reaches another
    # origin (Go's http.Client drops it on a cross-origin hop; so does this).
    # 303, and 301/302 after a POST, continue as a bodyless GET.
    def exchange(op, method, uri, body)
      auth = true
      6.times do
        res, raw = request(op, method, uri, body, auth)
        location = res["location"]
        return [res.code.to_i, raw] unless res.is_a?(Net::HTTPRedirection) && location && res.code != "304"

        nxt = uri + location
        auth &&= [nxt.scheme, nxt.host, nxt.port] == [uri.scheme, uri.host, uri.port]
        if res.code == "303" || (%w[301 302].include?(res.code) && method == "POST")
          method = "GET"
          body = nil
        end
        uri = nxt
      end
      raise Error.new(op, "too many redirects", unavailable: true)
    end

    def request(op, method, uri, body, auth)
      req = Net::HTTPGenericRequest.new(method, !body.nil?, true, uri.request_uri)
      req["Accept"] = "application/json"
      req["Authorization"] = "Bearer #{@token}" if auth
      if body
        req["Content-Type"] = "application/json"
        req.body = body
      end
      raw = +""
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: @timeout,
                                                read_timeout: @timeout, write_timeout: @timeout) do |http|
        http.request(req) do |r|
          r.read_body do |chunk|
            raw << chunk
            raise Error.new(op, "response body exceeds 8 MiB", status_code: r.code.to_i, unavailable: true) if raw.bytesize > MAX_RESPONSE_BYTES
          end
        end
      end
      [res, raw]
    rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout
      raise Error.new(op, "timed out", unavailable: true, retryable: true)
    rescue *NETWORK_ERRORS => e
      # Refused dial, DNS, reset, TLS: the host could not be consulted.
      raise Error.new(op, redact("unreachable: #{e.class}: #{e.message}"), unavailable: true, retryable: true)
    end

    def decode(op, status, raw, expect_body)
      raise http_error(op, status, raw) unless (200..299).cover?(status)
      return nil unless expect_body
      # A 2xx with no body is not the contract: decoding it into a default
      # would tell a forget caller the delete happened.
      raise Error.new(op, "empty response body", status_code: status, unavailable: true) if raw.strip.empty?

      JSON.parse(raw)
    rescue JSON::ParserError
      # In practice a proxy's HTML error page: we never reached a working
      # novamem. Not retryable — the same request parses the same way.
      raise Error.new(op, "malformed response body", status_code: status, unavailable: true)
    end

    def http_error(op, status, raw)
      message = code = ""
      begin
        payload = JSON.parse(raw)
        if payload.is_a?(Hash) && payload["error"].to_s != ""
          message = payload["error"].to_s
          code = payload["code"].to_s
        end
      rescue JSON::ParserError
        nil
      end
      if message.empty?
        text = raw.to_s.dup.force_encoding(Encoding::UTF_8).scrub.strip
        message = text.length > 256 ? "#{text[0, 256]}…" : text
      end
      # The server's message and code are quoted verbatim; a server echoing
      # the credential back would otherwise launder it into the logs.
      message = redact(message)
      code = redact(code)
      unavailable = status >= 500 || status == 429
      Error.new(op, message, status_code: status, code: code, unavailable: unavailable, retryable: unavailable)
    end
  end
end
