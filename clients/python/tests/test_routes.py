import json
import keyword
import re
import unittest
from pathlib import Path

import novamem

ROUTES = json.loads(
    (Path(__file__).resolve().parents[2] / "contract" / "routes.json").read_text()
)


def pyident(name):
    s = re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()
    return s + "_" if keyword.iskeyword(s) else s


class Routes(unittest.TestCase):
    # proved by: renaming Client.session_recap fails this test.
    def test_every_method_resolves(self):
        for key, r in ROUTES.items():
            for m in r.get("methods", []):
                cls, meth = m["name"].split(".")
                for c in (getattr(novamem, cls), getattr(novamem, "Async" + cls)):
                    with self.subTest(f"{key} {c.__name__}.{pyident(meth)}"):
                        self.assertTrue(callable(getattr(c, pyident(meth), None)))


if __name__ == "__main__":
    unittest.main()
