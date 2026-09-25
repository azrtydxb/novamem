# frozen_string_literal: true

require "minitest/autorun"
require "socket"
require "novamem"

# A redirect must never carry the bearer to another origin.
class RedirectTest < Minitest::Test
  # One-request HTTP server; yields the request's Authorization header.
  def serve(response)
    server = TCPServer.new("127.0.0.1", 0)
    seen = Queue.new
    Thread.new do
      client = server.accept
      auth = "none"
      while (line = client.gets) && line != "\r\n"
        auth = line.split(":", 2)[1].strip if line.downcase.start_with?("authorization:")
      end
      seen << auth
      client.write(response)
      client.close
    end
    ["http://127.0.0.1:#{server.addr[1]}", seen]
  end

  OK = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}"

  def redirect(location) = "HTTP/1.1 302 Found\r\nLocation: #{location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"

  # proved by: keeping `auth` true across origins in Transport#exchange
  # fails this test.
  def test_a_cross_origin_redirect_drops_the_bearer
    target, seen_target = serve(OK)
    # 127.0.0.1 vs localhost: a different origin for the same host.
    origin, seen_origin = serve(redirect("#{target.sub("127.0.0.1", "localhost")}/health"))
    assert Novamem::Client.new(origin, "nm_secret").health
    assert_equal "Bearer nm_secret", seen_origin.pop
    assert_equal "none", seen_target.pop, "the bearer followed a redirect to another origin"
  end

  def test_another_port_is_another_origin
    target, seen_target = serve(OK)
    port = target[/\d+\z/]
    origin, = serve(redirect("http://127.0.0.1:#{port}/health"))
    assert Novamem::Client.new(origin, "nm_secret").health
    assert_equal "none", seen_target.pop
  end

  def test_a_same_origin_redirect_keeps_the_bearer
    server = TCPServer.new("127.0.0.1", 0)
    seen = Queue.new
    Thread.new do
      2.times do |i|
        client = server.accept
        auth = "none"
        while (line = client.gets) && line != "\r\n"
          auth = line.split(":", 2)[1].strip if line.downcase.start_with?("authorization:")
        end
        seen << auth
        client.write(i.zero? ? redirect("/moved") : OK)
        client.close
      end
    end
    assert Novamem::Client.new("http://127.0.0.1:#{server.addr[1]}", "nm_secret").health
    assert_equal ["Bearer nm_secret", "Bearer nm_secret"], [seen.pop, seen.pop]
  end
end
