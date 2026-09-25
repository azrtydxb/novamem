# frozen_string_literal: true

require_relative "lib/novamem/version"

Gem::Specification.new do |s|
  s.name = "novamem"
  s.version = Novamem::VERSION
  s.summary = "Ruby client for novamem, the tiered memory service for agents"
  s.authors = ["novamem contributors"]
  s.license = "Apache-2.0"
  s.homepage = "https://github.com/azrtydxb/novamem"
  s.metadata = {
    "source_code_uri" => "https://github.com/azrtydxb/novamem/tree/main/clients/ruby",
    "rubygems_mfa_required" => "true"
  }
  s.required_ruby_version = ">= 3.2"
  s.files = Dir["lib/**/*.rb", "README.md"]
  # Standard library only (ADR 0009): no add_dependency, by design.
end
