# frozen_string_literal: true

# Live round trip against a real server, for the sdk-smoke CI job.
#
#   NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… ruby -Ilib smoke.rb up|down
#
# up:   capture → search finds it → forget deletes it → search no longer finds it.
# down: the server has been stopped; search must report unavailable, not an
#       empty result. Every failure prints "ruby <step>: <detail>" and exits 1.

require "securerandom"
require "novamem"

def fail!(step, detail)
  puts "ruby #{step}: #{detail}"
  exit 1
end

def step(name)
  yield
rescue StandardError => e
  fail!(name, e.message)
end

c = step("connect") { Novamem::Client.new(ENV.fetch("NOVAMEM_SMOKE_URL", ""), ENV.fetch("NOVAMEM_SMOKE_TOKEN", "")) }

if ARGV.first == "down"
  begin
    c.search(Novamem::SearchRequest.new(query: "anything"))
  rescue Novamem::Error => e
    fail!("down", "want unavailable, got #{e.message}") unless e.unavailable?
    puts "PASS ruby down"
    exit 0
  end
  fail!("down", "search succeeded against a stopped server")
end

marker = SecureRandom.hex(12)
query = Novamem::SearchRequest.new(query: marker, namespace: "sdk-smoke")
cap = step("capture") do
  c.capture(Novamem::CaptureRequest.new(content: "sdk-smoke ruby #{marker}", namespace: "sdk-smoke", force: true))
end
fail!("capture", "not saved: #{cap.inspect}") if cap.id.to_s.empty?
hits = step("search") { c.search(query) }
fail!("search", "captured #{cap.id} not found") unless hits.results.any? { |r| r.id == cap.id }
gone = step("forget") { c.forget(Novamem::ForgetRequest.new(id: cap.id)) }
fail!("forget", gone.inspect) unless gone.deleted
after = step("search-after-forget") { c.search(query) }
fail!("search-after-forget", "#{cap.id} still returned") if after.results.any? { |r| r.id == cap.id }
puts "PASS ruby up"
