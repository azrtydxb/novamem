# frozen_string_literal: true

require "minitest/autorun"
require "novamem"

class WireTest < Minitest::Test
  # proved by: skipping nil before checking `required` in to_h_wire fails this test.
  def test_required_nullable_fields_are_sent_as_null
    assert_equal({ "entries" => [], "nextAfterId" => nil },
                 Novamem::ExportPage.new(entries: [], next_after_id: nil).to_h_wire)
  end

  def test_unset_optional_fields_are_omitted
    assert_equal({ "query" => "coffee" }, Novamem::SearchRequest.new(query: "coffee", namespace: "").to_h_wire)
  end

  # proved by: passing strings through Wire.timestamp unchanged fails this test.
  def test_timestamps_are_sent_as_utc_with_a_z
    assert_equal({ "since" => "2026-09-24T10:00:00.000Z" },
                 Novamem::RecentRequest.new(since: "2026-09-24T12:00:00+02:00").to_h_wire)
    assert_equal({ "since" => "yesterday-ish" }, Novamem::RecentRequest.new(since: "yesterday-ish").to_h_wire)
  end

  def test_each_type_has_its_own_fields
    refute_equal Novamem::SearchRequest::FIELDS, Novamem::ForgetResult::FIELDS
  end
end
