"""A Python port of ``@agent-watch/fingerprint`` (AWT-263), digest for digest.

Two ports of one scheme only agree if they agree on the boring things, so every
rule here is pinned to ``tests/vectors.json`` — a byte copy of core's golden
vectors — and ``tests/test_vectors.py`` replays all 49 cases through this module.

Three places where "the obvious Python" is the wrong Python, and why:

- **Whitespace is the Unicode ``White_Space`` property, not ``str.isspace()``.**
  Python calls U+001C..U+001F (the file/group/record/unit separators) whitespace
  and Unicode does not, so ``str.rstrip()`` would strip a byte Node keeps and the
  two ports would hash different text. :data:`WHITESPACE` is the property, spelled
  out from the vectors' ``rules.whitespace``.

- **Numbers are written as ECMAScript writes them.** ``repr(1e-7)`` is ``1e-07``
  and ``String(1e-7)`` is ``1e-7``; ``repr(1e16)`` is ``1e+16`` and JavaScript
  writes all seventeen digits. Canonical JSON is hashed as text, so one differing
  character is a differing toolset digest. :func:`_es_number` implements
  ``Number::toString``.

- **Object keys sort by UTF-16 code unit, not by code point.** They only differ
  above U+FFFF, where a surrogate pair sorts below U+E000 in UTF-16 and above it
  in Python. Sorting on the UTF-16-BE encoding costs one ``encode`` per key.

ponytail: ``tests/vectors.json`` is a *copy* of
``packages/fingerprint/test/vectors.json`` (agent-watch-core @ 207ba472), not a
shared artefact — this repo cannot see core, so nothing here detects core editing
its own copy. The ceiling is silent drift; what is caught is this port drifting
from the copy, which fails CI. The upgrade path is publishing the vectors as a
versioned artefact both repos depend on.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from decimal import Decimal
from typing import Any

#: Names the rules in ``tests/vectors.json``. Digests from different schemes never compare.
FINGERPRINT_SCHEME = "agent-watch-fingerprint/1"

SHINGLE_TOKENS = 8
DIGEST_BYTES = 16
MAX_PREFIX_SHINGLES = 512
MAX_SOURCE_SHINGLES = 20_000
MAX_SOURCE_BYTES = 1024 * 1024
INSTRUCTION_ROLES = frozenset({"system", "developer"})

#: The Unicode ``White_Space`` property, as ``rules.whitespace`` lists it.
WHITESPACE = frozenset(
    "\t\n\v\f\r \x85\xa0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)
_WS_CLASS = "[\\t\\n\\v\\f\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]"
_SPACE_RUN = re.compile(_WS_CLASS + "+")

# "abc "\n  "def", 'abc ' +\n 'def', f"abc "\\\n f"def": concatenation, so the halves join directly.
_CONCAT_SEAM = re.compile("[\"'`][ \t]*(?:[+\\\\][ \t]*)?\n[ \t\n]*(?:\\+[ \t]*)?[bfruBFRU]{0,2}[\"'`]")
# "abc",\n  "def" inside an array: elements are joined by a separator at runtime, so a space.
_ELEMENT_SEAM = re.compile("[\"'`][ \t]*,[ \t]*\n[ \t\n]*[bfruBFRU]{0,2}[\"'`]")
# Escapes are undone whatever the backslash count, so "C:\\new" in source meets C:\new at runtime.
_WHITESPACE_ESCAPE = re.compile(r"(?<!\\)\\+[ntr]")
_QUOTE_ESCAPE = re.compile("(?<!\\\\)\\\\+(?=[\"'`])")
_BACKSLASH_RUN = re.compile(r"\\{2,}")
_QUOTE = re.compile("[\"'`]")

SOURCE_EXTENSIONS = frozenset(
    {".py", ".md", ".txt", ".j2", ".jinja", ".yaml", ".yml", ".json", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
)

_LOW_SURROGATE = "\ud800"
_HIGH_SURROGATE = "\udfff"

#: Why a call has no prefix digest. The members are spelled as ``RuntimeUncoveredCause`` spells them.
NO_INSTRUCTIONS = "no_instructions"
EMPTY_INSTRUCTIONS = "empty_instructions"

#: Why a source file produced no shingle digests.
TOO_LARGE = "too_large"
UNSUPPORTED_EXTENSION = "unsupported_extension"

#: How deep a tool definition may nest before :func:`canonical_json` refuses it.
#:
#: The port-parity trap AWT-268's comment records: Node's ``canonicalJson``
#: throws ``RangeError`` somewhere around 2,250–3,000 levels — a *stack-dependent*
#: depth, not a constant — while Python's ``json`` encoder parses the same value
#: happily. A port written from the vectors alone would therefore emit a digest
#: exactly where Node crashes, and no golden vector can see it. So this port
#: states a bound of its own, far below either language's stack: 100 levels is an
#: order of magnitude past the deepest tool schema anyone writes and nowhere near
#: what either runtime can take, which makes it a number both ports can hold.
#: AWT-288 moves this bound into the vectors' ``rules`` block; when it lands, take
#: the bound from there and delete this constant.
MAX_TOOL_DEPTH = 100


class ToolDepthExceeded(ValueError):
    """A tool definition nested deeper than :data:`MAX_TOOL_DEPTH`."""


def rstrip_whitespace(text: str) -> str:
    """Drop the trailing run of Unicode ``White_Space``.

    A backward scan rather than a regex: the anchored pattern core uses is there
    to keep a long run linear, and in Python the same job is a ``while`` loop that
    is linear by construction.

    :param text: Any text.
    :returns: ``text`` without its trailing whitespace run.
    """
    end = len(text)

    while end and text[end - 1] in WHITESPACE:
        end -= 1

    return text[:end]


def normalise(text: str) -> str:
    """NFC, CRLF to LF, trailing whitespace off every line and off the end. Never lowercases.

    :param text: Prompt or source text as the platform stored it.
    :returns: The text every digest in this module is taken over.
    """
    folded = unicodedata.normalize("NFC", text).replace("\r\n", "\n")

    return rstrip_whitespace("\n".join(rstrip_whitespace(line) for line in folded.split("\n")))


def prefix_text(messages: list[Any]) -> str | None:
    """The normalised text of the leading ``system``/``developer`` run, joined by a blank line.

    This is what :func:`prefix_digest` hashes and what a producer passes to
    :func:`shingle_digests`. Joining with anything else changes the shingles, so
    producers must not roll their own join.

    :param messages: Messages in order, in whatever shape the platform stored them.
    :returns: The prefix text, or ``None`` when the first message is not an instruction.
    """
    leading: list[Any] = []

    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in INSTRUCTION_ROLES:
            break

        leading.append(message)

    if not leading:
        return None

    return normalise("\n\n".join(_content_text(message.get("content")) for message in leading))


def prefix_digest(messages: list[Any]) -> dict[str, Any]:
    """sha256 hex of :func:`prefix_text`, or the reason there is none.

    :param messages: Messages in order.
    :returns: ``{"digest": <64 hex>, "cause": None}`` or ``{"digest": None, "cause": <reason>}``.
    """
    text = prefix_text(messages)

    if text is None:
        return {"digest": None, "cause": NO_INSTRUCTIONS}

    if text == "":
        return {"digest": None, "cause": EMPTY_INSTRUCTIONS}

    return {"digest": hashlib.sha256(_utf8(text)).hexdigest(), "cause": None}


def toolset_digest(tools: list[Any]) -> str | None:
    """sha256 hex of the tool definitions as canonical JSON, sorted and newline-joined.

    Accepts the OpenAI (``function.name``) and Anthropic (``name``) shapes.

    :param tools: Tool definitions as parsed JSON.
    :returns: 64 hex characters, or ``None`` when there are no tools.
    :raises ToolDepthExceeded: A definition nests past :data:`MAX_TOOL_DEPTH`.
    """
    if not tools:
        return None

    entries = sorted(
        ((_tool_name(tool), canonical_json(tool)) for tool in tools),
        key=lambda entry: (_utf16(entry[0]), _utf16(entry[1])),
    )

    return hashlib.sha256(_utf8("\n".join(entry[1] for entry in entries))).hexdigest()


def shingle_digests(text: str) -> list[str]:
    """16-byte hex digests of every 8-token window, deduplicated in order, at most 512.

    :param text: Prompt text, normally :func:`prefix_text`'s output.
    :returns: Up to 512 digests of 32 hex characters each.
    """
    return _window_digests(tokens(text), MAX_PREFIX_SHINGLES)


def source_shingle_digests(file_text: str, ext: str) -> dict[str, Any]:
    """The same windows over a whole source file, at most 20,000.

    :param file_text: The file's text.
    :param ext: Its extension including the dot, as ``os.path.splitext`` gives it.
    :returns: ``{"digests": [...], "skipped": None}`` or empty digests and a reason.
    """
    skipped = source_skip_reason(ext, len(_utf8(file_text)))

    if skipped is not None:
        return {"digests": [], "skipped": skipped}

    return {"digests": _window_digests(tokens(file_text), MAX_SOURCE_SHINGLES), "skipped": None}


def source_skip_reason(ext: str, byte_length: int) -> str | None:
    """Why :func:`source_shingle_digests` would skip a file, from its name and size alone.

    :param ext: Extension including the dot; compared lowercased.
    :param byte_length: The file's UTF-8 byte length.
    :returns: A reason, or ``None`` when the file would be read.
    """
    if ext.lower() not in SOURCE_EXTENSIONS:
        return UNSUPPORTED_EXTENSION

    return TOO_LARGE if byte_length > MAX_SOURCE_BYTES else None


def tokens(text: str) -> list[str]:
    """Normalise, undo the source-literal seams and escapes, then split on whitespace.

    The seam rules are what let a runtime prompt meet the source file it was
    rendered from: an implicitly concatenated Python f-string and the string it
    produces token the same way.

    :param text: Prompt or source text.
    :returns: The tokens shingles are taken over.
    """
    stripped = _QUOTE_ESCAPE.sub("", _WHITESPACE_ESCAPE.sub(" ", _ELEMENT_SEAM.sub(" ", _CONCAT_SEAM.sub("", normalise(text)))))
    braced = _BACKSLASH_RUN.sub("\\\\", stripped).replace("{{", "{").replace("}}", "}")

    return [token for token in _SPACE_RUN.split(_QUOTE.sub("", braced)) if token]


def canonical_json(value: Any, depth: int = 0) -> str:
    """One JSON text per value: keys sorted by UTF-16 code unit, no whitespace, ES numbers.

    :param value: Parsed JSON — object, array, string, number, boolean or null.
    :param depth: Recursion depth, checked against :data:`MAX_TOOL_DEPTH`.
    :returns: The canonical JSON text.
    :raises ToolDepthExceeded: ``value`` nests past :data:`MAX_TOOL_DEPTH`.
    """
    if depth > MAX_TOOL_DEPTH:
        raise ToolDepthExceeded(f"tool definition nests deeper than {MAX_TOOL_DEPTH} levels")

    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item, depth + 1) for item in value) + "]"

    if isinstance(value, dict):
        keys = sorted(value, key=_utf16)

        return "{" + ",".join(f"{_es_string(key)}:{canonical_json(value[key], depth + 1)}" for key in keys) + "}"

    if value is None:
        return "null"

    if isinstance(value, bool):
        return "true" if value else "false"

    if isinstance(value, (int, float)):
        return _es_number(value)

    return _es_string(value)


def _content_text(content: Any) -> str:
    """Message content as text: a string as is, a parts list keeping its text parts, else empty."""
    if isinstance(content, str):
        return content

    if not isinstance(content, list):
        return ""

    return "\n\n".join(
        part["text"]
        for part in content
        if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
    )


def _tool_name(tool: Any) -> str:
    """``name``, else ``function.name``, else the empty string."""
    if not isinstance(tool, dict):
        return ""

    if isinstance(tool.get("name"), str):
        return tool["name"]

    function = tool.get("function")

    return function["name"] if isinstance(function, dict) and isinstance(function.get("name"), str) else ""


def _window_digests(words: list[str], cap: int) -> list[str]:
    """Deduplicated 16-byte digests of every 8-token window, stopping at ``cap`` distinct ones."""
    digests: dict[str, None] = {}

    for start in range(len(words) - SHINGLE_TOKENS + 1):
        if len(digests) >= cap:
            break

        window = " ".join(words[start : start + SHINGLE_TOKENS])
        digests[hashlib.sha256(_utf8(window)).digest()[:DIGEST_BYTES].hex()] = None

    return list(digests)


def _utf8(text: str) -> bytes:
    """UTF-8 bytes, with unpaired surrogates replaced as Node's ``Buffer.from`` replaces them.

    ``json.loads('"\\ud800"')` yields a lone surrogate that ``str.encode`` refuses
    outright, while Node has already turned it into U+FFFD by the time it hashes.
    Raising where the other port produces a digest is the divergence this module
    exists to avoid — and in the processor it would drop the call.
    """
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError:
        return text.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")


def _utf16(text: str) -> bytes:
    """A sort key ordering strings by UTF-16 code unit, as JavaScript's ``<`` does."""
    return text.encode("utf-16-be", "surrogatepass")


def _es_string(text: str) -> str:
    r"""``JSON.stringify`` of a string: non-ASCII as it is, control characters and lone surrogates escaped.

    The surrogate half is ES2019's well-formed ``JSON.stringify``, which writes an
    unpaired surrogate as ``\udXXX`` rather than emitting it. ``json.dumps`` emits
    it, which would give a different canonical JSON text and so a different
    toolset digest. Every surrogate code point still standing in a Python string
    is unpaired by construction — ``json.loads`` has already joined the pairs.
    """
    encoded = json.dumps(text, ensure_ascii=False)

    if not any(_LOW_SURROGATE <= char <= _HIGH_SURROGATE for char in encoded):
        return encoded

    return "".join(
        f"\\u{ord(char):04x}" if _LOW_SURROGATE <= char <= _HIGH_SURROGATE else char for char in encoded
    )


def _es_number(value: float | int) -> str:
    """``Number::toString``, which is not ``repr``.

    JavaScript reads every JSON number as a double, so an integer is widened
    before it is written — ``rules.toolsetDigest`` says so explicitly, and it is
    what makes an integer past 2^53 hash the same in both ports.
    """
    try:
        number = float(value)
    except OverflowError:
        # `json.loads` keeps `1e400` as an arbitrary-precision int where
        # `JSON.parse` has already made it `Infinity`. Widening it here is what
        # the vectors' "integers beyond 2^53 are first read as doubles" means, and
        # an overflow is the same `Infinity` the other port is holding.
        return "null"

    if math.isnan(number) or math.isinf(number):
        return "null"

    if number == 0:
        return "0"

    sign = "-" if number < 0 else ""
    digits, point = _shortest_digits(abs(number))
    count = len(digits)

    if count <= point <= 21:
        return sign + digits + "0" * (point - count)

    if 0 < point <= 21:
        return sign + digits[:point] + "." + digits[point:]

    if -6 < point <= 0:
        return sign + "0." + "0" * -point + digits

    exponent = point - 1
    mantissa = digits if count == 1 else digits[0] + "." + digits[1:]

    return f"{sign}{mantissa}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"


def _shortest_digits(number: float) -> tuple[str, int]:
    """The shortest round-tripping digits of a positive double, and its decimal point position.

    ``repr`` already gives the shortest digits — the same ones V8 prints — so the
    only work is reading the point position back out of them.
    """
    _, digits, exponent = Decimal(repr(number)).as_tuple()
    text = "".join(str(digit) for digit in digits)
    # `value = int(text) * 10**exponent`, i.e. `0.<text> * 10**(len(text) + exponent)`.
    # Trailing zeros move neither the value nor the point, so they just go.
    return text.rstrip("0") or "0", len(text) + int(exponent)
