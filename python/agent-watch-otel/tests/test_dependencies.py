"""The package's one promise about its own dependencies, checked rather than stated.

"Stdlib plus ``opentelemetry-sdk``" is not a preference — this code runs inside
the customer's production application, where every transitive dependency becomes
a version they have to resolve against their own. A dependency added by accident
would be discovered by whoever's install broke, which is too late; so it is
discovered here.
"""

from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent / "agent_watch_otel"

#: The only non-stdlib root this package may import.
ALLOWED_THIRD_PARTY = {"opentelemetry"}


def _roots(module: Path) -> set[str]:
    """Every top-level module name imported by one file, relative imports aside."""
    tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
    roots: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)

        if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            roots.add(node.module.split(".")[0])

    return roots


class Dependencies(unittest.TestCase):
    """What the shipped package is allowed to import."""

    def test_every_shipped_module_is_examined(self) -> None:
        """`rglob`, not `glob`: a subpackage added later must not escape the check."""
        self.assertEqual(sorted(PACKAGE.rglob("*.py")), sorted(PACKAGE.glob("**/*.py")))
        self.assertIn("processor.py", [module.name for module in PACKAGE.rglob("*.py")])

    def test_nothing_beyond_the_standard_library_and_opentelemetry(self) -> None:
        stdlib = getattr(sys, "stdlib_module_names", None)

        if stdlib is None:
            self.skipTest("sys.stdlib_module_names needs Python 3.10; CI runs this on the release runtime")

        for module in sorted(PACKAGE.rglob("*.py")):
            with self.subTest(module=module.name):
                outside = _roots(module) - set(stdlib) - ALLOWED_THIRD_PARTY

                self.assertEqual(outside, set(), f"{module.name} imports a dependency the package does not declare")


if __name__ == "__main__":
    unittest.main()
