import unittest

import novamem


class Wire(unittest.TestCase):
    # proved by: dropping None before checking `required` in _Wire.to_wire
    # fails this test.
    def test_required_nullable_fields_are_sent_as_null(self):
        page = novamem.ExportPage(entries=[], next_after_id=None)
        self.assertEqual(page.to_wire(), {"entries": [], "nextAfterId": None})

    def test_unset_optional_fields_are_omitted(self):
        req = novamem.SearchRequest(query="coffee", namespace="", k=None)
        self.assertEqual(req.to_wire(), {"query": "coffee"})

    # proved by: passing strings through _dt_to_wire unchanged fails this test.
    def test_timestamps_are_sent_as_utc_with_a_z(self):
        from datetime import datetime, timezone

        as_text = novamem.RecentRequest(since="2026-09-24T12:00:00+02:00")
        as_dt = novamem.RecentRequest(
            since=datetime(2026, 9, 24, 10, tzinfo=timezone.utc)
        )
        self.assertEqual(as_text.to_wire(), {"since": "2026-09-24T10:00:00.000Z"})
        self.assertEqual(as_dt.to_wire(), {"since": "2026-09-24T10:00:00.000Z"})
        self.assertEqual(
            novamem.RecentRequest(since="yesterday-ish").to_wire(),
            {"since": "yesterday-ish"},
        )

    def test_round_trip_ignores_unknown_keys(self):
        entry = novamem.MemoryEntry.from_wire(
            {"id": "e1", "content": "c", "futureField": 1}
        )
        self.assertEqual(entry.to_wire(), {"id": "e1", "content": "c"})


if __name__ == "__main__":
    unittest.main()
