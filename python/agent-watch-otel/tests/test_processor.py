"""The processor end to end: beside Phoenix, against a sink, and with the sink gone.

The test that matters most is :class:`Canary`, and it is written to be able to
fail: it reads raw request bytes rather than parsed fields, and it looks for
*fragments* of the planted prompt rather than the whole string. Its first draft
did neither and passed while ``build_call`` was sending a 64-character prompt
prefix in ``release`` — which is how a canary comes to certify a leak.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
import unittest
from unittest import mock

from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from agent_watch_otel import AgentWatchSpanProcessor

from . import spans
from .sink import Sink

TOKEN = "awsdk_test_token"


def processor(endpoint: str, **kwargs: object) -> AgentWatchSpanProcessor:
    """A processor wired for a test: flush fast, give up fast."""
    settings = {"flush_seconds": 0.05, "timeout_seconds": 2.0, "instance_id": "trip-planner-prod"}

    return AgentWatchSpanProcessor(token=TOKEN, endpoint=endpoint, **{**settings, **kwargs})


def closed_port() -> int:
    """A port nothing is listening on: bind it, read it, release it."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))

        return probe.getsockname()[1]


class BesidePhoenix(unittest.TestCase):
    """Adding this processor must not change what the customer's own exporter receives."""

    def test_the_other_exporter_receives_identical_spans(self) -> None:
        phoenix_only = InMemorySpanExporter()
        alongside = InMemorySpanExporter()

        without = spans.provider(SimpleSpanProcessor(phoenix_only))
        spans.emit(without)
        without.shutdown()

        with Sink() as sink:
            ours = processor(sink.endpoint)
            with_us = spans.provider(SimpleSpanProcessor(alongside), ours)
            spans.emit(with_us)
            with_us.shutdown()

            self.assertEqual(len(alongside.get_finished_spans()), 1)
            self.assertEqual(_shape(alongside), _shape(phoenix_only))
            self.assertIn(spans.CANARY_SYSTEM, str(_shape(alongside)), "Phoenix still gets the prompt")


class Delivery(unittest.TestCase):
    """What reaches a healthy endpoint."""

    def test_a_call_arrives_with_the_resource_phoenix_drops(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            spans.emit(provider)
            provider.shutdown()

            calls = sink.calls()

            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["platform"], "otel_processor")
            self.assertEqual(calls[0]["service_name"], "trip-planner-ai")
            self.assertEqual(calls[0]["service_version"], "2026.09.16+abc1234")
            self.assertEqual(calls[0]["agent_name"], "llm.call.planner")
            self.assertEqual(calls[0]["model"], "claude-haiku-4-5-20251001")
            self.assertEqual(calls[0]["input_tokens"], 1200)
            self.assertEqual(ours.stats()["sent"], 1)

    def test_the_token_travels_as_a_bearer_credential(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            spans.emit(provider)
            provider.shutdown()

            self.assertEqual(sink.headers[0]["Authorization"], f"Bearer {TOKEN}")

    def test_non_llm_spans_are_never_reported(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            spans.emit(provider, name="trip_setup.node.planner", **{"openinference.span.kind": "CHAIN"})
            provider.shutdown()

            self.assertEqual(sink.calls(), [])

    def test_a_batch_never_exceeds_the_contract_maximum(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint, flush_seconds=5.0, max_queue=4096)
            provider = spans.provider(ours)

            for index in range(260):
                spans.emit(provider, name=f"llm.call.{index}")

            provider.shutdown()

            self.assertTrue(all(len(body) for body in sink.bodies))
            self.assertLessEqual(max(len(batch["calls"]) for batch in map(_json, sink.bodies)), 250)
            self.assertEqual(len(sink.calls()), 260)


#: The shortest run of planted characters that counts as a leak.
#:
#: Not the whole string. A leak is far more often a *fragment* — "just the first
#: 64 characters, for debugging" — and a canary that only looks for the whole
#: planted string passes while that ships. Sixteen characters of a prompt is
#: sixteen characters of somebody's production data, and short enough that no
#: digest or identifier collides with one by accident.
LEAK_WINDOW = 16


def fragments(text: str) -> list[str]:
    """Every ``LEAK_WINDOW``-character window of a planted string."""
    return [text[start : start + LEAK_WINDOW] for start in range(max(1, len(text) - LEAK_WINDOW + 1))]


class Canary(unittest.TestCase):
    """No run of planted prompt text may appear in any outbound request. Ever.

    Three things make this able to fail rather than merely able to pass:

    - It reads the **raw request bytes**, so a leak through a field added later, a
      dict key or a log line is caught the same way an obvious one is.
    - It looks for **fragments**, so a truncated leak is still a leak. A first
      draft of this test checked only for whole planted strings and passed with a
      64-character prompt prefix being sent in ``release``.
    - It checks the body **decoded as well as raw**, because ``json.dumps``
      escapes non-ASCII and ``\\u05d0`` is not the byte the canary planted.
    """

    def test_no_prompt_text_leaves_the_process(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            spans.emit(provider)
            provider.shutdown()

            self.assertTrue(sink.bodies, "the canary proves nothing if nothing was sent")

            for body, headers in zip(sink.bodies, sink.headers):
                request = body.decode("utf-8", "replace") + json.loads(body.decode()).__repr__() + repr(headers)

                for planted in spans.CANARY_STRINGS:
                    for fragment in fragments(planted):
                        self.assertNotIn(fragment, request, f"prompt text leaked: {fragment!r}")

    def test_the_canary_can_fail(self) -> None:
        """The canary's own check, run against a body that does leak.

        A canary nobody has watched go red is a canary nobody knows the shape of.
        This asserts on the assertion itself, so the check cannot rot into one
        that passes on everything.
        """
        leaked = json.dumps({"calls": [{"release": spans.CANARY_SYSTEM[:64]}]}).encode("utf-8")
        found = [
            fragment
            for planted in spans.CANARY_STRINGS
            for fragment in fragments(planted)
            if fragment in leaked.decode()
        ]

        self.assertTrue(found, "the canary would not notice a truncated prompt in an outbound body")

    def test_the_digests_are_there_instead(self) -> None:
        """The other half of the canary: silence would pass it too."""
        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            spans.emit(provider)
            provider.shutdown()

            call = sink.calls()[0]

            self.assertRegex(call["prefix_sha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(call["toolset_sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(call["prefix_shingles_sha256"])
            self.assertTrue(all(len(digest) == 32 for digest in call["prefix_shingles_sha256"]))


class EndpointDown(unittest.TestCase):
    """The application keeps working; the drop counter is how anyone finds out."""

    def test_the_span_completes_and_the_drop_counter_increments(self) -> None:
        exporter = InMemorySpanExporter()
        ours = processor(f"http://127.0.0.1:{closed_port()}")
        provider = spans.provider(SimpleSpanProcessor(exporter), ours)

        spans.emit(provider)
        provider.shutdown()

        self.assertEqual(len(exporter.get_finished_spans()), 1, "the app's own span still finished")
        self.assertEqual(ours.stats()["dropped_send_failed"], 1)
        self.assertEqual(ours.dropped, 1)

    def test_a_refusing_endpoint_drops_rather_than_retries(self) -> None:
        with Sink(status=400) as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            spans.emit(provider)
            provider.shutdown()

            self.assertEqual(len(sink.bodies), 1, "a refused batch is not sent again")
            self.assertEqual(ours.stats()["dropped_send_failed"], 1)


class BoundedQueue(unittest.TestCase):
    """A full queue drops and counts; it never grows and never blocks the caller."""

    def test_a_full_queue_drops_and_counts(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint, flush_seconds=30.0, max_queue=3)
            provider = spans.provider(ours)

            for index in range(20):
                spans.emit(provider, name=f"llm.call.{index}")

            self.assertGreater(ours.stats()["dropped_queue_full"], 0)
            self.assertLessEqual(ours.stats()["dropped_queue_full"] + 3 + 1, 20 + 1)
            provider.shutdown()


class Lifecycle(unittest.TestCase):
    """A provider is shut down explicitly and again from ``atexit``."""

    def test_shutting_down_twice_leaves_force_flush_answering_at_once(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            spans.emit(provider)
            provider.shutdown()
            ours.shutdown()

            started = time.monotonic()

            self.assertTrue(ours.force_flush(timeout_millis=2_000))
            self.assertLess(time.monotonic() - started, 1.0)
            self.assertEqual(ours.stats()["sent"], 1)


class Fork(unittest.TestCase):
    """A preforking server is the normal way to run a Python web application."""

    def test_a_forked_child_still_sends(self) -> None:
        if not hasattr(os, "fork"):
            self.skipTest("no fork on this platform")

        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            child = os.fork()

            if child == 0:  # pragma: no cover - asserted through the exit status
                spans.emit(provider, name="llm.call.child")
                provider.shutdown()
                os._exit(0 if ours.stats()["sent"] == 1 else 1)

            self.assertEqual(os.waitpid(child, 0)[1], 0, "the child's sender thread never restarted")
            provider.shutdown()


class Counters(unittest.TestCase):
    """`dropped` promises every call read and never delivered, so nothing may vanish silently."""

    def test_a_failure_while_building_a_call_is_counted(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)

            with mock.patch("agent_watch_otel.processor.build_call", side_effect=ValueError("boom")):
                spans.emit(provider)

            provider.shutdown()

            self.assertEqual(ours.stats()["dropped_error"], 1)
            self.assertEqual(ours.dropped, 1)


class BlackHole:
    """An endpoint that completes the TCP handshake and then never answers.

    A load balancer with no healthy backend, or a firewall dropping silently.
    Unlike a refused connection it fails slowly, so it is what turns a shutdown
    into a wait.
    """

    def __init__(self) -> None:
        self._held: list[socket.socket] = []
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(16)
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return

            self._held.append(connection)

    @property
    def endpoint(self) -> str:
        return f"http://127.0.0.1:{self._listener.getsockname()[1]}"

    def close(self) -> None:
        self._listener.close()

        for connection in self._held:
            connection.close()

    def __enter__(self) -> "BlackHole":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class ShutdownBudget(unittest.TestCase):
    """Shutting down must not be the thing that outlasts a SIGTERM grace period."""

    def test_a_hung_endpoint_cannot_stretch_shutdown_past_its_budget(self) -> None:
        with BlackHole() as hung:
            ours = processor(hung.endpoint, timeout_seconds=10.0, shutdown_seconds=1.0, max_queue=600)
            provider = spans.provider(ours)

            for index in range(600):
                spans.emit(provider, name=f"llm.call.{index}")

            time.sleep(0.3)  # let the sender get stuck mid-request

            started = time.monotonic()
            ours.shutdown()
            first = time.monotonic() - started

            started = time.monotonic()
            ours.shutdown()  # what atexit does after an explicit provider.shutdown()
            second = time.monotonic() - started

            # Before the budget existed this measured first=10.00s second=10.01s.
            self.assertLess(first, 3.0, f"first shutdown took {first:.2f}s")
            self.assertLess(second, 0.5, f"second shutdown took {second:.2f}s")
            self.assertLess(first + second, 3.0)


class SenderSurvival(unittest.TestCase):
    """The docstring promises one sender thread that never dies. This is that promise."""

    def test_a_raising_send_does_not_kill_the_sender(self) -> None:
        with Sink() as sink:
            ours = processor(sink.endpoint)
            provider = spans.provider(ours)
            failures = {"left": 1}
            original = ours._send

            def explode(batch: object) -> None:
                if failures["left"]:
                    failures["left"] -= 1

                    raise RuntimeError("something _send does not catch")

                original(batch)

            ours._send = explode  # type: ignore[method-assign]
            spans.emit(provider, name="llm.call.first")
            ours.force_flush(timeout_millis=5_000)
            spans.emit(provider, name="llm.call.second")
            provider.shutdown()

            self.assertEqual(ours.stats()["dropped_send_failed"], 1)
            self.assertEqual(ours.stats()["sent"], 1, "the sender kept working after the raise")

    def test_an_unserialisable_call_is_counted_not_fatal(self) -> None:
        """`json.dumps` sits inside `_send`'s guard, not outside it."""
        with Sink() as sink:
            ours = processor(sink.endpoint)
            ours._queue.put_nowait({"type": "runtime.call", "bad": {1, 2}})  # a set is not JSON
            ours.force_flush(timeout_millis=5_000)
            spans.emit(spans.provider(ours), name="llm.call.after")
            ours.shutdown()

            self.assertEqual(ours.stats()["dropped_send_failed"], 1)
            self.assertEqual(ours.stats()["sent"], 1)


class Configuration(unittest.TestCase):
    """A missing credential is a startup error, not a silent no-op."""

    def test_no_token_is_refused_at_construction(self) -> None:
        with self.assertRaises(ValueError):
            AgentWatchSpanProcessor(token="  ", endpoint="http://localhost:1")

    def test_no_endpoint_is_refused_at_construction(self) -> None:
        with self.assertRaises(ValueError):
            AgentWatchSpanProcessor(token="t", endpoint="")

    def test_the_route_is_joined_to_the_endpoint(self) -> None:
        ours = AgentWatchSpanProcessor(token="t", endpoint="https://ingest.example.com/")

        self.assertEqual(ours._url, "https://ingest.example.com/v1/runtime/calls")
        ours.shutdown()


def _json(body: bytes) -> dict:
    return json.loads(body)


def _shape(exporter: InMemorySpanExporter) -> list[tuple]:
    """Everything about an exported span except what differs between two runs.

    Span and trace ids and the wall clock are per-run; the name, kind, status,
    resource and every attribute are what "Phoenix receives the same span" means.
    """
    return [
        (
            span.name,
            span.kind,
            span.status.status_code,
            dict(span.resource.attributes),
            dict(span.attributes or {}),
            [(event.name, dict(event.attributes or {})) for event in span.events],
        )
        for span in exporter.get_finished_spans()
    ]


if __name__ == "__main__":
    unittest.main()
