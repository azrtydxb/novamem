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

    def test_round_trip_ignores_unknown_keys(self):
        entry = novamem.MemoryEntry.from_wire(
            {"id": "e1", "content": "c", "futureField": 1}
        )
        self.assertEqual(entry.to_wire(), {"id": "e1", "content": "c"})


if __name__ == "__main__":
    unittest.main()
