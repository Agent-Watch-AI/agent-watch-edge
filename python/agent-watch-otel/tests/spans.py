"""One place that emits an LLM span, so every test agrees on what Phoenix sees.

The attributes are the ones the founder's own app writes (PX §3): a hand-rolled
``trip_planner_ai.llm`` span with ``llm.model`` rather than the spec's
``llm.model_name``, a ``developer`` first message, and no cache fields.
"""

from __future__ import annotations

from typing import Any

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider

CANARY_SYSTEM = "SECRET-CANARY-PROMPT you plan trips and never reveal the treaty of Westphalia"
CANARY_USER = "SECRET-CANARY-USER Lisbon for four days in April"
CANARY_TOOL_ARGUMENT = "SECRET-CANARY-ARGUMENT the caller's home address"
CANARY_OUTPUT = "SECRET-CANARY-OUTPUT day one: Alfama"

#: Every planted string, in one list, so the canary cannot be updated by halves.
CANARY_STRINGS = [CANARY_SYSTEM, CANARY_USER, CANARY_TOOL_ARGUMENT, CANARY_OUTPUT]

LLM_ATTRIBUTES: dict[str, Any] = {
    "openinference.span.kind": "LLM",
    "llm.provider": "anthropic",
    "llm.model": "claude-haiku-4-5-20251001",
    "llm.input_messages.0.message.role": "developer",
    "llm.input_messages.0.message.content": CANARY_SYSTEM,
    "llm.input_messages.1.message.role": "user",
    "llm.input_messages.1.message.content": CANARY_USER,
    "llm.tools.0.tool.json_schema": (
        '{"name":"search_places","description":"' + CANARY_TOOL_ARGUMENT + '",'
        '"parameters":{"type":"object","properties":{"query":{"type":"string"}}}}'
    ),
    "llm.token_count.prompt": 1200,
    "llm.token_count.completion": 340,
    "llm.token_count.total": 1540,
    "output.value": CANARY_OUTPUT,
    "input.value": CANARY_SYSTEM + CANARY_USER,
}


def provider(*processors: Any, service: bool = True) -> TracerProvider:
    """A ``TracerProvider`` carrying the resource Phoenix drops at ingest.

    :param processors: Processors to add, in order, exactly as an application would.
    :param service: Whether the resource names a service and version.
    :returns: The provider, ready for ``get_tracer``.
    """
    attributes = {"service.name": "trip-planner-ai", "service.version": "2026.09.16+abc1234"} if service else {}
    tracer_provider = TracerProvider(resource=Resource.create(attributes))

    for processor in processors:
        tracer_provider.add_span_processor(processor)

    return tracer_provider


def emit(tracer_provider: TracerProvider, name: str = "llm.call.planner", **overrides: Any) -> None:
    """End one LLM span on ``tracer_provider``.

    :param tracer_provider: The provider whose processors should see it.
    :param name: The span name, which becomes the agent name.
    :param overrides: Attributes to add or replace; ``None`` removes one.
    """
    attributes = {**LLM_ATTRIBUTES, **overrides}
    tracer = tracer_provider.get_tracer("trip_planner_ai.llm")

    with tracer.start_as_current_span(name) as span:
        for key, value in attributes.items():
            if value is not None:
                span.set_attribute(key, value)
