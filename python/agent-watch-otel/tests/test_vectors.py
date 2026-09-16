"""The parity check: this port against core's golden vectors, case for case.

``tests/vectors.json`` is a byte copy of
``agent-watch-core/packages/fingerprint/test/vectors.json`` at commit 207ba472.
Every case in it is replayed here, so the port cannot drift from the copy without
CI going red.

It also covers the one thing no golden vector can: **depth**. AWT-268's
port-parity comment records that Node's ``canonicalJson`` raises ``RangeError``
on deeply nested tool definitions at a stack-dependent depth while Python's
encoder does not, so a port written from the vectors alone would return a digest
exactly where the other implementation crashes. Until AWT-288 puts the bound in
the vectors' ``rules`` block, this port states its own —
:data:`agent_watch_otel.fingerprint.MAX_TOOL_DEPTH` — and the two tests at the
bottom of this file are what hold it.

Run it on its own with::

    python -m unittest tests.test_vectors
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from agent_watch_otel import fingerprint

VECTORS = json.loads((Path(__file__).parent / "vectors.json").read_text(encoding="utf-8"))

#: What each vector's ``function`` runs here. The two helpers at the end are not
#: exported by core either; they exist to lock the join a producer must use.
RUNNERS = {
    "normalise": lambda case: fingerprint.normalise(case["text"]),
    "prefixText": lambda case: fingerprint.prefix_text(case["messages"]),
    "prefixDigest": lambda case: fingerprint.prefix_digest(case["messages"]),
    "toolsetDigest": lambda case: fingerprint.toolset_digest(case["tools"]),
    "shingleDigests": lambda case: fingerprint.shingle_digests(case["text"]),
    "sourceShingleDigests": lambda case: fingerprint.source_shingle_digests(case["fileText"], case["ext"]),
    "sourceSkipReason": lambda case: fingerprint.source_skip_reason(case["ext"], case["byteLength"]),
    "rekey": lambda case: _rekey(case),
    "prefixShingles": lambda case: _prefix_shingles(case),
    "sharedShingles": lambda case: _shared_shingles(case),
}


def _rekey(case: dict) -> str:
    """Server-side re-keying. A client never holds a tenant key; the vector is still replayed."""
    import hashlib
    import hmac

    key = bytes.fromhex(case["tenantKeyHex"])

    return hmac.new(key, bytes.fromhex(case["digest"]), hashlib.sha256).digest()[:16].hex()


def _prefix_shingles(case: dict) -> list[str]:
    """What a producer sends as ``prefix_shingles_sha256``."""
    return fingerprint.shingle_digests(fingerprint.prefix_text(case["messages"]) or "")


def _shared_shingles(case: dict) -> int:
    """How many of a prompt's shingles also appear in the file it was rendered from."""
    source = set(fingerprint.source_shingle_digests(case["fileText"], case["ext"])["digests"])

    return sum(1 for digest in fingerprint.shingle_digests(case["runtimeText"]) if digest in source)


def _expected(case: dict) -> object:
    """The vector's expected value, with core's camelCase keys read as this port's."""
    expected = case["expected"]

    if case["function"] == "sourceShingleDigests":
        return {"digests": expected["digests"], "skipped": expected["skipped"]}

    return expected


class VectorParity(unittest.TestCase):
    """Every golden vector, replayed through the Python port."""

    def test_scheme_matches(self) -> None:
        self.assertEqual(VECTORS["scheme"], fingerprint.FINGERPRINT_SCHEME)

    def test_every_case_is_runnable(self) -> None:
        """A vector whose function this port does not implement is drift, not a skip."""
        self.assertEqual(sorted({case["function"] for case in VECTORS["cases"]}), sorted(RUNNERS))

    def test_vectors(self) -> None:
        for case in VECTORS["cases"]:
            with self.subTest(function=case["function"], name=case["name"]):
                self.assertEqual(RUNNERS[case["function"]](case["input"]), _expected(case))


class ToolDepth(unittest.TestCase):
    """The bound the shared vectors cannot express, and the behaviour it buys.

    Replace both tests with the shared over-depth case when AWT-288 lands.
    """

    @staticmethod
    def _nested(depth: int) -> dict:
        """A tool definition whose ``parameters`` nest ``depth`` levels deep."""
        value: object = {"type": "string"}

        for _ in range(depth):
            value = {"type": "object", "properties": {"next": value}}

        return {"name": "deep", "parameters": value}

    def test_at_the_bound_still_hashes(self) -> None:
        """A definition inside the bound is an ordinary tool, not an edge case."""
        digest = fingerprint.toolset_digest([self._nested(fingerprint.MAX_TOOL_DEPTH // 4)])

        self.assertRegex(digest or "", r"^[0-9a-f]{64}$")

    def test_over_the_bound_refuses_rather_than_diverging(self) -> None:
        """Past the bound this port raises, where Node raises, instead of returning a digest.

        Python's own encoder would happily hash this value. That is the whole
        problem: a digest only one of the two ports can produce is worse than no
        digest, because the server cannot tell the two cases apart.
        """
        with self.assertRaises(fingerprint.ToolDepthExceeded):
            fingerprint.toolset_digest([self._nested(fingerprint.MAX_TOOL_DEPTH + 1)])


class EcmaScriptNumbers(unittest.TestCase):
    """``Number::toString``, which the vectors' ``rules.toolsetDigest`` names verbatim."""

    def test_numbers_are_written_as_javascript_writes_them(self) -> None:
        cases = {
            1.0: "1",
            1e21: "1e+21",
            1e-7: "1e-7",
            0.000001: "0.000001",
            1e16: "10000000000000000",
            -0.0: "0",
            1.5: "1.5",
            123: "123",
            2**53 + 1: "9007199254740992",
            float("nan"): "null",
            float("inf"): "null",
        }

        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(fingerprint.canonical_json(value), expected)

    def test_a_literal_too_large_for_a_double_is_null_as_it_is_in_node(self) -> None:
        """`JSON.parse` has already made `1e400` Infinity; `json.loads` keeps a big int."""
        tools = json.loads('[{"name":"a","v":1e400}]')

        self.assertEqual(
            fingerprint.toolset_digest(tools),
            "bff3fd20891c332940bb4bfe68620befef925712b1cc22c123596e32b70125ff",
        )

    def test_a_lone_surrogate_hashes_as_node_hashes_it(self) -> None:
        """Both halves: escaped inside canonical JSON, U+FFFD when text is hashed directly.

        Expected values were taken by running core's own `fingerprint.ts` on the
        same inputs, since no golden vector covers an unpaired surrogate.
        """
        self.assertEqual(
            fingerprint.toolset_digest(json.loads('[{"name":"a","v":"lo\\ud800hi"}]')),
            "633cd9dea9503f1b1e7763df639beac1a3b159fc1010b2cfe0b09c75f27bf44c",
        )
        self.assertEqual(
            fingerprint.prefix_digest(json.loads('[{"role":"system","content":"pre\\ud800post"}]'))["digest"],
            "62a32c8f4feae312cf7e7161ca1cba178e009bac8848bf46da3cef703e1bf9d5",
        )

    def test_keys_sort_by_utf16_code_unit(self) -> None:
        """An astral character sorts below U+E000 in UTF-16 and above it by code point."""
        self.assertEqual(fingerprint.canonical_json({"\U0001f600": 1, "": 2}), '{"\U0001f600":1,"":2}')


if __name__ == "__main__":
    unittest.main()
