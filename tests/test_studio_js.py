"""Runs the studio's Node test suite as part of the Python one."""
from __future__ import annotations

import os
import subprocess
import unittest

from helpers import ROOT


class TestStudioJavaScript(unittest.TestCase):
    def test_node_suite(self) -> None:
        # List the files: Node 24 (the LTS run.sh installs on Linux) won't take a directory here.
        tests_dir = os.path.join(ROOT, "tests")
        files = sorted(os.path.join(tests_dir, f) for f in os.listdir(tests_dir) if f.endswith(".test.mjs"))
        res = subprocess.run(["node", "--test", *files], capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stdout[-3000:] + res.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
