"""Building one ``runtime.call`` from one span: the mappings and the awkward spans.

The span is real, not a stub — it goes through a ``TracerProvider`` and is read
back as the SDK hands it to a processor, so the attribute flattening these tests
assert on is the flattening the OTel SDK actually does.
"""

from __future__ import annotations

import unittest
from typing import Any

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider

from agent_watch_otel import build_call, is_llm_span
from agent_watch_otel.call import _cap_utf16

from . import spans


class Capture(SpanProcessor):
    """Keeps finished spans so a test can build a call from one."""

    def __init__(self) -> None:
        self.spans: list[Any] = []

    def on_end(self, span: Any) -> None:
        self.spans.append(span)


def call(**overrides: Any) -> dict[str, Any] | None:
    """The call built from one emitted span, with ``overrides`` applied to its attributes."""
    capture = Capture()
    name = overrides.pop("__name__", "llm.call.planner")
    service = overrides.pop("__service__", True)
    provider = spans.provider(capture, service=service)
    spans.emit(provider, name=name, **overrides)

    return build_call(capture.spans[0], "trip-planner-prod")


class Identity(unittest.TestCase):
    """What names the call and where it came from."""

    def test_the_span_name_is_the_agent_name(self) -> None:
        self.assertEqual(call()["agent_name"], "llm.call.planner")

    def test_ids_are_the_platform_hex(self) -> None:
        built = call()

        self.assertRegex(built["external_id"], r"^[0-9a-f]{16}$")
        self.assertRegex(built["trace_id"], r"^[0-9a-f]{32}$")

    def test_occurred_at_states_its_offset(self) -> None:
        self.assertRegex(call()["occurred_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$")

    def test_the_resource_falls_back_to_the_instance_name(self) -> None:
        """Phoenix drops the resource; a deployment that sets none still identifies itself."""
        built = call(__service__=False)

        self.assertNotIn("service_name", built)
        self.assertEqual(built["instance_id"], "trip-planner-prod")

    def test_control_characters_never_reach_the_gateway(self) -> None:
        """A NUL in a span name is a 400 for the whole batch, so it is removed here."""
        self.assertEqual(call(__name__="llm.call\x00.planner  ")["agent_name"], "llm.call.planner")


#: One emoji is one Python character and two UTF-16 code units.
ASTRAL = "\U0001f600"


class Utf16Lengths(unittest.TestCase):
    """The gateway counts UTF-16 code units, so this has to count them too.

    Zod's `.max()` is JavaScript's `String.length`. Capping on Python characters
    sent a 200-character span name as 395 units, and because the runtime schema is
    strict that refused the whole batch: 161 calls lost to one emoji, 160 of them
    belonging to other agents.
    """

    def _units(self, text: str) -> int:
        return len(text.encode("utf-16-le")) // 2

    def test_every_storable_field_is_capped_in_utf16_units(self) -> None:
        """Not just `agent_name` — each of these is customer-controlled text."""
        long_astral = ASTRAL * 300
        built = call(
            __name__=long_astral,
            **{
                "llm.model": long_astral,
                "llm.provider": long_astral,
            },
        )

        for field, limit in (("agent_name", 200), ("model", 200), ("provider", 200), ("instance_id", 200)):
            with self.subTest(field=field):
                self.assertLessEqual(self._units(built[field]), limit)

    def test_the_resource_fields_are_capped_too(self) -> None:
        capture = Capture()
        long_astral = ASTRAL * 300
        provider = TracerProvider(
            resource=Resource.create({"service.name": long_astral, "service.version": long_astral})
        )
        provider.add_span_processor(capture)
        spans.emit(provider)
        built = build_call(capture.spans[0], ASTRAL * 300)

        for field in ("service_name", "service_version", "instance_id"):
            with self.subTest(field=field):
                self.assertLessEqual(self._units(built[field]), 200)

    def test_a_surrogate_pair_is_never_cut_in_half(self) -> None:
        """Half a pair is an unpaired surrogate, which the contract refuses outright."""
        capped = _cap_utf16(ASTRAL * 300, 201)

        self.assertEqual(self._units(capped), 200)
        self.assertEqual(capped, ASTRAL * 100)

    def test_text_inside_the_limit_is_untouched(self) -> None:
        self.assertEqual(_cap_utf16("llm.call.planner", 200), "llm.call.planner")


class Model(unittest.TestCase):
    """``llm.model_name`` is the spec's; the founder's app writes ``llm.model`` (PX §3)."""

    def test_model_name_wins_when_both_are_present(self) -> None:
        self.assertEqual(call(**{"llm.model_name": "gpt-4o"})["model"], "gpt-4o")

    def test_model_is_the_fallback(self) -> None:
        self.assertEqual(call()["model"], "claude-haiku-4-5-20251001")

    def test_a_span_with_no_model_is_not_sent(self) -> None:
        """Spend that cannot be priced is dropped and counted, never sent under a guess."""
        self.assertIsNone(call(**{"llm.model": None}))

    def test_provider_falls_back_to_unknown(self) -> None:
        self.assertEqual(call(**{"llm.provider": None})["provider"], "unknown")


class Tokens(unittest.TestCase):
    """Counted separately, because a cache read and a cache write are priced separately."""

    def test_prompt_and_completion_are_required_and_default_to_zero(self) -> None:
        built = call(**{"llm.token_count.prompt": None, "llm.token_count.completion": None})

        self.assertEqual((built["input_tokens"], built["output_tokens"]), (0, 0))

    def test_cache_and_reasoning_counts_travel_when_present(self) -> None:
        built = call(
            **{
                "llm.token_count.prompt_details.cache_read": 900,
                "llm.token_count.prompt_details.cache_write": 100,
                "llm.token_count.completion_details.reasoning": 40,
            }
        )

        self.assertEqual(built["cache_read_tokens"], 900)
        self.assertEqual(built["cache_write_tokens"], 100)
        self.assertEqual(built["reasoning_tokens"], 40)

    def test_absent_optional_counts_are_absent_not_null(self) -> None:
        """The schema is strict and refuses ``null``; an optional field is omitted or set."""
        self.assertNotIn("cache_read_tokens", call())


class Prefix(unittest.TestCase):
    """The leading run of ``system`` *or* ``developer`` messages — tripPlanner uses both."""

    def test_a_developer_first_message_is_an_instruction(self) -> None:
        built = call()

        self.assertRegex(built["prefix_sha256"], r"^[0-9a-f]{64}$")
        self.assertNotIn("uncovered_cause", built)

    def test_the_prefix_shingles_travel_with_it(self) -> None:
        digests = call()["prefix_shingles_sha256"]

        self.assertTrue(digests)
        self.assertLessEqual(len(digests), 512)
        self.assertTrue(all(len(digest) == 32 for digest in digests))

    def test_a_user_first_message_has_no_instructions(self) -> None:
        built = call(**{"llm.input_messages.0.message.role": "user"})

        self.assertNotIn("prefix_sha256", built)
        self.assertEqual(built["uncovered_cause"], "no_instructions")

    def test_a_blank_instruction_is_its_own_cause(self) -> None:
        built = call(
            **{
                "llm.input_messages.0.message.content": "   ",
                "llm.input_messages.1.message.role": None,
                "llm.input_messages.1.message.content": None,
            }
        )

        self.assertEqual(built["uncovered_cause"], "empty_instructions")

    def test_no_messages_at_all_reads_as_hidden_input(self) -> None:
        built = call(
            **{
                "llm.input_messages.0.message.role": None,
                "llm.input_messages.0.message.content": None,
                "llm.input_messages.1.message.role": None,
                "llm.input_messages.1.message.content": None,
            }
        )

        self.assertEqual(built["uncovered_cause"], "input_hidden")
        self.assertNotIn("prefix_sha256", built)
        self.assertRegex(built["toolset_sha256"], r"^[0-9a-f]{64}$", "masked input does not mask the tools")

    def test_structured_content_parts_are_read(self) -> None:
        """OpenInference also flattens content into ``contents.N.message_content.*``."""
        built = call(
            **{
                "llm.input_messages.0.message.content": None,
                "llm.input_messages.0.message.contents.0.message_content.type": "text",
                "llm.input_messages.0.message.contents.0.message_content.text": spans.CANARY_SYSTEM,
            }
        )

        self.assertEqual(built["prefix_sha256"], call()["prefix_sha256"])


class Tools(unittest.TestCase):
    """Tools come from ``llm.tools.*``, or from raw ``gen_ai.tool.definitions`` (PX §3)."""

    def test_a_tool_schema_produces_a_digest(self) -> None:
        self.assertRegex(call()["toolset_sha256"], r"^[0-9a-f]{64}$")

    def test_no_tools_is_not_a_failure(self) -> None:
        built = call(**{"llm.tools.0.tool.json_schema": None})

        self.assertNotIn("toolset_sha256", built)
        self.assertNotIn("uncovered_cause", built)

    def test_an_unparseable_definition_says_so_beside_the_prefix(self) -> None:
        """The contract allows a resolved prefix beside ``tools_unparsed``; that is this call."""
        built = call(**{"llm.tools.0.tool.json_schema": "{not json"})

        self.assertNotIn("toolset_sha256", built)
        self.assertEqual(built["uncovered_cause"], "tools_unparsed")
        self.assertIn("prefix_sha256", built)

    def test_gen_ai_definitions_are_read_when_phoenix_leaves_them_raw(self) -> None:
        built = call(
            **{
                "llm.tools.0.tool.json_schema": None,
                "gen_ai.tool.definitions": '[{"name":"search_places","parameters":{"type":"object"}}]',
            }
        )

        self.assertRegex(built["toolset_sha256"], r"^[0-9a-f]{64}$")

    def test_an_over_deep_definition_is_unparsed_rather_than_hashed(self) -> None:
        """Node raises where Python would hash, so this port reports it as unparsed."""
        import json

        value: Any = {"type": "string"}

        for _ in range(200):
            value = {"type": "object", "properties": {"next": value}}

        built = call(**{"llm.tools.0.tool.json_schema": json.dumps({"name": "deep", "parameters": value})})

        self.assertNotIn("toolset_sha256", built)
        self.assertEqual(built["uncovered_cause"], "tools_unparsed")


class Filtering(unittest.TestCase):
    """Only OpenInference ``LLM`` spans are read at all."""

    def test_only_llm_spans_qualify(self) -> None:
        capture = Capture()
        provider = spans.provider(capture)
        spans.emit(provider, name="a", **{"openinference.span.kind": "CHAIN"})
        spans.emit(provider, name="b")

        self.assertEqual([is_llm_span(span) for span in capture.spans], [False, True])


if __name__ == "__main__":
    unittest.main()
