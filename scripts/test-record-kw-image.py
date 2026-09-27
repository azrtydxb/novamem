"""Exercise CI image write-back against disposable local Git repositories."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("record-kw-image.sh").resolve()
IMAGE = "ghcr.io/azrtydxb/novamem"


class ImagePinTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="novamem-image-pin-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "checkout"
        self.run_git("init", "--bare", str(self.remote), cwd=self.root)
        self.run_git("clone", str(self.remote), str(self.repo), cwd=self.root)
        self.run_git("checkout", "-b", "main")
        self.run_git("config", "user.name", "Image pin test")
        self.run_git("config", "user.email", "test@example.invalid")
        self.manifest = self.repo / "deploy/overlays/kw/deployment.yaml"
        self.manifest.parent.mkdir(parents=True)
        self.manifest.write_text(f"image: {IMAGE}:sha-0000000 # managed by CI\n")
        self.first = self.commit("Initial deployment")

    def run_git(self, *args, cwd=None):
        return subprocess.check_output(
            ["git", *args],
            cwd=cwd or self.repo,
            stderr=subprocess.STDOUT,
            text=True,
        ).strip()

    def commit(self, message):
        self.run_git("add", ".")
        self.run_git("commit", "-m", message)
        self.run_git("push", "origin", "HEAD:main")
        return self.run_git("rev-parse", "HEAD")

    def record(self, sha, **overrides):
        env = dict(
            os.environ,
            GITHUB_ACTIONS="true",
            GITHUB_SHA=sha,
            IMAGE_TAG="sha-" + sha[:7],
            REGISTRY_IMAGE=IMAGE,
        )
        env.update(overrides)
        return subprocess.run(
            ["bash", str(SCRIPT)], cwd=self.repo, env=env,
            capture_output=True, text=True, timeout=30,
        )

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_records_and_is_idempotent(self):
        self.assert_success(self.record(self.first))
        self.assertIn("sha-" + self.first[:7], self.manifest.read_text())
        self.assertIn("[skip ci]", self.run_git("log", "-1", "--format=%s"))
        head = self.run_git("rev-parse", "HEAD")
        self.assert_success(self.record(self.first))
        self.assertEqual(head, self.run_git("rev-parse", "HEAD"))

    def test_older_build_cannot_replace_newer_pin(self):
        self.assert_success(self.record(self.first))
        (self.repo / "source.txt").write_text("New source commit\n")
        second = self.commit("New source")
        self.assert_success(self.record(second))
        self.assert_success(self.record(self.first))
        self.assertIn("sha-" + second[:7], self.manifest.read_text())

    def test_retries_a_rejected_push(self):
        hook = self.remote / "hooks/pre-receive"
        hook.write_text(
            '#!/bin/sh\n'
            'if [ ! -f rejected-once ]; then touch rejected-once; exit 1; fi\n'
        )
        hook.chmod(0o700)
        self.assert_success(self.record(self.first))
        self.assertIn("sha-" + self.first[:7], self.manifest.read_text())

    def test_refuses_non_ci_and_mismatched_tags(self):
        head = self.run_git("rev-parse", "HEAD")
        self.assertNotEqual(self.record(self.first, GITHUB_ACTIONS="false").returncode, 0)
        self.assertNotEqual(self.record(self.first, IMAGE_TAG="sha-abcdef0").returncode, 0)
        self.assertEqual(head, self.run_git("rev-parse", "HEAD"))


if __name__ == "__main__":
    unittest.main()
