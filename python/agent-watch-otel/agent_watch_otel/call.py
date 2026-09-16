"""One finished LLM span in, one ``runtime.call`` payload out — digests only.

This is the whole confidentiality boundary of the package. Prompt text, tool
arguments and model responses are read here, hashed here, and left here: the
dict this module returns holds digests, token counts, ids and timestamps, and
there is no branch that copies a message body into it. ``on_end`` calls
:func:`build_call` on the host application's own thread, so what the sender
thread later sees has already had the text taken out of it.

Two things the contract (AWT-70) makes non-negotiable:

- **It is strict.** An unknown field fails the whole batch with a ``400``, so
  every key here is one ``runtime.schema.ts`` names. Nothing is added "for later".
- **Every identity string is checked before it is sent.** A NUL or an unassigned
  code point in a span name is a ``400`` for the *batch*, which would cost every
  other tenant call in it — and a control character is exactly the sort of thing
  a span name picks up. :func:`_storable` removes them here rather than letting
  the gateway refuse them.
"""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Mapping

from .fingerprint import (
    EMPTY_INSTRUCTIONS,
    NO_INSTRUCTIONS,
    ToolDepthExceeded,
    prefix_digest,
    prefix_text,
    shingle_digests,
    toolset_digest,
)

#: The platform enum member for a customer-run span processor (AWT-70).
PLATFORM = "otel_processor"

SPAN_KIND = "openinference.span.kind"
LLM_KIND = "LLM"

AGENT_NAME_MAX = 200
ID_MAX = 200
TOKEN_MAX = 1_000_000_000

#: The platform stored no input at all: the customer masked or hid it.
INPUT_HIDDEN = "input_hidden"
#: Tool definitions were present in a shape no parser recognised.
TOOLS_UNPARSED = "tools_unparsed"

_MESSAGE_ROLE = re.compile(r"^llm\.input_messages\.(\d+)\.message\.role$")
_MESSAGE_CONTENT = "llm.input_messages.{index}.message.content"
_MESSAGE_PART = re.compile(r"^llm\.input_messages\.(\d+)\.message\.contents\.(\d+)\.message_content\.type$")
_TOOL_SCHEMA = re.compile(r"^llm\.tools\.(\d+)\.tool\.json_schema$")
_GEN_AI_TOOLS = "gen_ai.tool.definitions"

# Code points Postgres cannot store or the contract refuses: control, unassigned,
# surrogate. Private use (Co) is storable and deliberately not in this set.
_UNSTORABLE = frozenset({"Cc", "Cn", "Cs"})


def build_call(span: Any, instance_id: str) -> dict[str, Any] | None:
    """Turn a finished LLM span into the ``runtime.call`` the ingest route accepts.

    :param span: A readable span whose ``openinference.span.kind`` is ``LLM``.
    :param instance_id: The tenant's own name for this deployment, used when the
        resource carries no ``service.name``.
    :returns: The payload, or ``None`` when the span names no model — spend that
        cannot be priced is counted as dropped rather than sent under a guess.
    """
    attributes: Mapping[str, Any] = span.attributes or {}
    model = _storable(_first_string(attributes, "llm.model_name", "llm.model"), ID_MAX)

    if model is None:
        return None

    resource = getattr(span, "resource", None)
    resource_attributes: Mapping[str, Any] = getattr(resource, "attributes", None) or {}
    service_name = _service_name(resource_attributes.get("service.name"))

    call: dict[str, Any] = {
        "type": "runtime.call",
        "platform": PLATFORM,
        "instance_id": _storable(instance_id, ID_MAX) or service_name or PLATFORM,
        "external_id": f"{span.context.span_id:016x}",
        "occurred_at": _iso(span.end_time),
        "agent_name": _storable(span.name, AGENT_NAME_MAX) or "unnamed",
        "trace_id": f"{span.context.trace_id:032x}",
        "provider": _storable(_first_string(attributes, "llm.provider", "llm.system"), ID_MAX) or "unknown",
        "model": model,
        "input_tokens": _tokens(attributes, "llm.token_count.prompt"),
        "output_tokens": _tokens(attributes, "llm.token_count.completion"),
    }

    _put(call, "cache_read_tokens", _optional_tokens(attributes, "llm.token_count.prompt_details.cache_read"))
    _put(call, "cache_write_tokens", _optional_tokens(attributes, "llm.token_count.prompt_details.cache_write"))
    _put(call, "reasoning_tokens", _optional_tokens(attributes, "llm.token_count.completion_details.reasoning"))
    _put(call, "service_name", service_name)
    _put(call, "service_version", _storable(resource_attributes.get("service.version"), ID_MAX))

    return {**call, **_fingerprint(attributes)}


def _service_name(value: Any) -> str | None:
    """The service the deploy named, never the SDK's placeholder for one it did not.

    An OTel ``Resource`` with no ``service.name`` gets ``unknown_service`` (or
    ``unknown_service:python``) filled in for it. Reporting that would put a
    fictional service on the connection page for every app that never set one —
    and this processor is the only producer that sends the field at all, because
    Phoenix drops the resource.
    """
    name = _storable(value, ID_MAX)

    return None if name is None or name.split(":")[0] == "unknown_service" else name


def _fingerprint(attributes: Mapping[str, Any]) -> dict[str, Any]:
    """The digest fields and, when one is missing, the single cause that says why.

    The contract allows a prefix digest beside ``tools_unparsed`` — a prompt that
    resolved while its tools did not is an ordinary call — but never a digest
    beside its own absence cause. So the prefix's cause wins when there is one.
    """
    messages = _messages(attributes)
    tools, parsed = _tools(attributes)
    digest = _toolset(tools) if parsed else None
    fields: dict[str, Any] = {}

    if digest is not None:
        fields["toolset_sha256"] = digest

    # Masked input does not mask the tools. The contract pairs each cause with
    # its own fragment, so a call whose prompt is hidden still reports the
    # toolset it resolved — half a fingerprint beats none of one.
    if not messages:
        return {**fields, "uncovered_cause": INPUT_HIDDEN}

    prefix = prefix_digest(messages)

    if prefix["digest"] is not None:
        fields["prefix_sha256"] = prefix["digest"]
        shingles = shingle_digests(prefix_text(messages) or "")

        # Omitted rather than sent empty. A prompt under eight tokens has no
        # windows, and an empty array says "no shingles" less clearly than the
        # absent field the schema already allows.
        if shingles:
            fields["prefix_shingles_sha256"] = shingles

    cause = prefix["cause"] if prefix["cause"] in (NO_INSTRUCTIONS, EMPTY_INSTRUCTIONS) else None

    if cause is None and (not parsed or (tools and digest is None)):
        cause = TOOLS_UNPARSED

    _put(fields, "uncovered_cause", cause)

    return fields


def _toolset(tools: list[Any]) -> str | None:
    """The toolset digest, or ``None`` when the definitions nest past the depth bound.

    An over-depth definition is reported as unparsed rather than hashed. Node's
    port raises there (AWT-268's port-parity comment), so a digest would be a
    value only one of the two implementations can produce.
    """
    try:
        return toolset_digest(tools)
    except ToolDepthExceeded:
        return None


def _messages(attributes: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The input messages, rebuilt from the flattened OpenInference attributes, in order."""
    messages: list[tuple[int, dict[str, Any]]] = []

    for key, value in attributes.items():
        match = _MESSAGE_ROLE.match(key)

        if match is None:
            continue

        index = int(match.group(1))
        messages.append((index, {"role": value, "content": _content(attributes, index)}))

    return [message for _, message in sorted(messages, key=lambda entry: entry[0])]


def _content(attributes: Mapping[str, Any], index: int) -> Any:
    """A message's content: the flat string, else its ``contents.N`` text parts."""
    flat = attributes.get(_MESSAGE_CONTENT.format(index=index))

    if isinstance(flat, str):
        return flat

    prefix = f"llm.input_messages.{index}.message.contents."
    parts: list[tuple[int, dict[str, str]]] = []

    for key, value in attributes.items():
        match = _MESSAGE_PART.match(key)

        if match is None or int(match.group(1)) != index or value != "text":
            continue

        part = int(match.group(2))
        text = attributes.get(f"{prefix}{part}.message_content.text")

        if isinstance(text, str):
            parts.append((part, {"type": "text", "text": text}))

    return [part for _, part in sorted(parts, key=lambda entry: entry[0])]


def _tools(attributes: Mapping[str, Any]) -> tuple[list[Any], bool]:
    """The tool definitions, and whether every definition that was there parsed.

    ``llm.tools.N.tool.json_schema`` first; Phoenix 20.9.0 leaves
    ``gen_ai.tool.definitions`` unconverted (PX §3), so that is read too.

    :returns: The parsed definitions, and ``False`` when tools were present in a
        shape no parser recognised — which is not the same as no tools at all.
    """
    indexed: list[tuple[int, str]] = []

    for key, value in attributes.items():
        match = _TOOL_SCHEMA.match(key)

        if match is not None and isinstance(value, str):
            indexed.append((int(match.group(1)), value))

    if indexed:
        tools = [_load(schema) for _, schema in sorted(indexed, key=lambda entry: entry[0])]

        return [tool for tool in tools if tool is not None], all(tool is not None for tool in tools)

    raw = attributes.get(_GEN_AI_TOOLS)

    if not isinstance(raw, str):
        return [], True

    parsed = _load(raw)

    if parsed is None:
        return [], False

    return (parsed, True) if isinstance(parsed, list) else ([parsed], True)


def _load(text: str) -> Any:
    """Parsed JSON, or ``None`` when the platform wrote something that is not JSON."""
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _first_string(attributes: Mapping[str, Any], *keys: str) -> str | None:
    """The first of ``keys`` holding a non-empty string."""
    for key in keys:
        value = attributes.get(key)

        if isinstance(value, str) and value.strip():
            return value

    return None


def _tokens(attributes: Mapping[str, Any], key: str) -> int:
    """A required token count, absent or unusable reading as zero."""
    return _optional_tokens(attributes, key) or 0


def _optional_tokens(attributes: Mapping[str, Any], key: str) -> int | None:
    """An optional token count, clamped into the range the contract accepts."""
    value = attributes.get(key)

    if not isinstance(value, (int, float)) or isinstance(value, bool) or value != value:
        return None

    return max(0, min(TOKEN_MAX, int(value)))


def _storable(value: Any, limit: int) -> str | None:
    """A trimmed, length-capped string with nothing in it the gateway would refuse.

    :param value: Any attribute value; anything but a string reads as absent.
    :param limit: The contract's maximum length for this field, in UTF-16 units.
    :returns: The storable text, or ``None`` when nothing is left of it.
    """
    if not isinstance(value, str):
        return None

    kept = "".join(char for char in value if unicodedata.category(char) not in _UNSTORABLE)

    return _cap_utf16(kept.strip(), limit).strip() or None


def _cap_utf16(text: str, limit: int) -> str:
    """Cut ``text`` to ``limit`` **UTF-16 code units**, which is what the gateway counts.

    Zod's ``.max()`` is JavaScript's ``String.length``, so one emoji costs two
    units there and one character here. Truncating on Python characters let a
    200-character span name arrive as 395 units, and because the runtime schema is
    strict a single over-length field refuses the *whole* batch with a ``400`` —
    measured at 161 calls lost to one emoji, 160 of them from other agents.

    Whole code points are copied, so a surrogate pair is never split in half.

    :param text: Storable text, already trimmed.
    :param limit: Maximum UTF-16 code units.
    :returns: ``text``, or its longest prefix fitting the limit.
    """
    if len(text.encode("utf-16-le")) // 2 <= limit:
        return text

    kept: list[str] = []
    units = 0

    for char in text:
        width = 2 if ord(char) > 0xFFFF else 1

        if units + width > limit:
            break

        kept.append(char)
        units += width

    return "".join(kept)


def _put(target: dict[str, Any], key: str, value: Any) -> None:
    """Set an optional field only when it has a value — the schema refuses ``null``."""
    if value is not None:
        target[key] = value


def _iso(end_time_ns: int) -> str:
    """A span's end as an ISO-8601 instant with an offset, which the contract requires.

    Microseconds are taken by integer division rather than through a float: at
    2026 epoch nanoseconds a double has about 256 ns of resolution left, which is
    enough to move a timestamp the gateway stores.
    """
    seconds, nanoseconds = divmod(int(end_time_ns), 1_000_000_000)

    return (
        datetime.fromtimestamp(seconds, tz=timezone.utc)
        .replace(microsecond=nanoseconds // 1000)
        .isoformat(timespec="milliseconds")
    )


def is_llm_span(span: Any) -> bool:
    """Whether this span is one the processor reports.

    :param span: Any finished span.
    :returns: ``True`` when its OpenInference kind is ``LLM``.
    """
    attributes = getattr(span, "attributes", None) or {}

    return attributes.get(SPAN_KIND) == LLM_KIND
