# frozen_string_literal: true

# Ruby client for novamem, a tiered memory service for agents.
#
#   c = Novamem::Client.new("https://novamem.example.com", token)
#   c.capture(Novamem::CaptureRequest.new(content: "User prefers dark roast"))
#   begin
#     hits = c.search(Novamem::SearchRequest.new(query: "coffee preference", k: 5))
#     # hits.results.empty? => "Nothing is stored about that." This one is knowledge.
#   rescue Novamem::Error => e
#     raise unless e.unavailable?
#     # "I could not look." Say so; do not claim ignorance.
#   end
#
# Standard library only. The client never retries on your behalf.

require_relative "novamem/version"
require_relative "novamem/errors"
require_relative "novamem/types"
require_relative "novamem/transport"
require_relative "novamem/client"
