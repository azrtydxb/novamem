# frozen_string_literal: true

require "minitest/autorun"
require "json"
require "novamem"

class RoutesTest < Minitest::Test
  # proved by: renaming Novamem::Client#session_recap fails this test.
  def test_every_route_is_accounted
    routes = JSON.parse(File.read(File.expand_path("../../contract/routes.json", __dir__)))
    routes.each do |key, r|
      Array(r["methods"]).each do |m|
        cls, meth = m["name"].split(".")
        name = meth.gsub(/([A-Z])/) { "_#{::Regexp.last_match(1).downcase}" }.sub(/\A_/, "")
        assert Novamem.const_get(cls).method_defined?(name), "#{key} #{cls}##{name}"
      end
    end
  end
end
