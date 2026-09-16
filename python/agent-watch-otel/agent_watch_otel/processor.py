"""The one line a Phoenix customer adds, and everything it must never do.

``on_end`` runs on whatever thread finished the customer's LLM call. Three rules
follow from that, and they outrank every other consideration in this file:

1. **It never touches the network.** ``on_end`` builds a payload and puts it on a
   bounded queue; a daemon thread does the POST. A queue that is full drops the
   call and counts it, because back-pressure here is back-pressure on the
   customer's request path.
2. **It never raises.** Every path out of ``on_end`` is wrapped. A bug in this
   package must cost the customer a missing cost record, never a failed request.
   ``BaseException`` is deliberately not caught: a ``KeyboardInterrupt`` arriving
   on this thread belongs to the host.
3. **It never holds prompt text past its own stack frame.** Digests are computed
   in ``on_end``, so what sits in the queue — and what a heap dump of the sender
   thread would show — is already hashed.

Phoenix is untouched throughout. This is a second processor on the same provider,
so their ``BatchSpanProcessor`` receives every span exactly as it did before.
"""

from __future__ import annotations

import json
import logging
import os
import queue
import threading
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urljoin

from opentelemetry.sdk.trace import SpanProcessor

from .call import build_call, is_llm_span

LOGGER = logging.getLogger("agent_watch_otel")

#: The contract's ceiling on one request (AWT-70's ``RUNTIME_BATCH_MAX_CALLS``).
BATCH_MAX_CALLS = 250
CALLS_PATH = "v1/runtime/calls"

DEFAULT_MAX_QUEUE = 2048
DEFAULT_FLUSH_SECONDS = 5.0
DEFAULT_TIMEOUT_SECONDS = 10.0

_SHUTDOWN = object()


class AgentWatchSpanProcessor(SpanProcessor):
    """Reports finished OpenInference ``LLM`` spans to Agent Watch as digests.

    Added beside the customer's own processors::

        tracer_provider = register(project_name=..., endpoint=..., batch=True)
        tracer_provider.add_span_processor(AgentWatchSpanProcessor(token=...))

    :param token: An SDK token scoped ``ingest:production``. Defaults to
        ``AGENT_WATCH_TOKEN``.
    :param endpoint: The ingest base URL. Defaults to ``AGENT_WATCH_ENDPOINT``.
    :param instance_id: This deployment's name, as the tenant knows it. Defaults
        to the resource's ``service.name``.
    :param max_queue: Calls held while the sender is behind or the endpoint is
        down. Past it, calls are dropped and counted rather than queued without
        bound in the customer's process.
    :param flush_seconds: How long a partial batch waits before it is sent.
    :param timeout_seconds: Network timeout for one POST.
    :raises ValueError: No token or no endpoint. This is raised at construction,
        on the application's startup path, where a missing credential is a
        configuration error the operator can see — never later, from ``on_end``.
    """

    def __init__(
        self,
        token: str | None = None,
        endpoint: str | None = None,
        *,
        instance_id: str | None = None,
        max_queue: int = DEFAULT_MAX_QUEUE,
        flush_seconds: float = DEFAULT_FLUSH_SECONDS,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        resolved_token = token or os.environ.get("AGENT_WATCH_TOKEN") or ""
        resolved_endpoint = endpoint or os.environ.get("AGENT_WATCH_ENDPOINT") or ""

        if not resolved_token.strip():
            raise ValueError("AgentWatchSpanProcessor needs a token, or AGENT_WATCH_TOKEN in the environment")

        if not resolved_endpoint.strip():
            raise ValueError("AgentWatchSpanProcessor needs an endpoint, or AGENT_WATCH_ENDPOINT in the environment")

        self._token = resolved_token.strip()
        self._url = urljoin(resolved_endpoint.strip().rstrip("/") + "/", CALLS_PATH)
        self._instance_id = instance_id or ""
        self._timeout = timeout_seconds
        self._flush_seconds = flush_seconds
        self._counters = {
            "sent": 0,
            "dropped_queue_full": 0,
            "dropped_send_failed": 0,
            "dropped_no_model": 0,
            "dropped_error": 0,
        }
        self._counter_lock = threading.Lock()
        self._stopped = threading.Event()
        self._max_queue = max_queue
        self._start()

        # A forked child inherits the queue but not the thread that drains it, so
        # without this the child fills its queue once and then drops every call
        # for the life of the process while `sent` stays at zero. Preforking is
        # the normal way to run a Python web application — gunicorn `--preload`,
        # uWSGI, Celery — and `register()` plus `add_span_processor` usually run
        # at import time, in the parent. Unix only; there is no fork to hook on
        # Windows.
        if hasattr(os, "register_at_fork"):
            os.register_at_fork(after_in_child=self._restart_after_fork)

    def _start(self) -> None:
        """Give this process its own queue and sender thread."""
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=self._max_queue)
        self._worker = threading.Thread(target=self._run, name="agent-watch-otel", daemon=True)
        self._worker.start()

    def _restart_after_fork(self) -> None:
        """Rebuild the queue and sender in a forked child.

        The parent keeps whatever was queued when it forked and sends it; the
        child starts empty rather than sending the parent's calls a second time.
        """
        self._start()

    @property
    def dropped(self) -> int:
        """Calls this processor read but never delivered, for any reason.

        :returns: The running total. It is the number an operator watches: while
            the endpoint is down it rises and the application keeps working.
        """
        with self._counter_lock:
            return sum(count for name, count in self._counters.items() if name != "sent")

    def stats(self) -> dict[str, int]:
        """Delivered and dropped counts, each drop under its own reason.

        :returns: A snapshot copy — ``sent``, ``dropped_queue_full``,
            ``dropped_send_failed``, ``dropped_no_model``, ``dropped_error``.
        """
        with self._counter_lock:
            return dict(self._counters)

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        """Nothing. A call is only reportable once it has its token counts."""

    def on_end(self, span: Any) -> None:
        """Hash a finished LLM span and hand it to the sender thread.

        :param span: The span the SDK has just finished. Anything that is not an
            OpenInference ``LLM`` span is ignored, and nothing about it is read.
        """
        try:
            if self._stopped.is_set() or not is_llm_span(span):
                return

            call = build_call(span, self._instance_id)

            if call is None:
                self._count("dropped_no_model")

                return

            try:
                self._queue.put_nowait(call)
            except queue.Full:
                self._count("dropped_queue_full")
        except Exception:  # noqa: BLE001 - the host application must not see our failures
            # Counted, not only logged. `dropped` promises "every call read and
            # never delivered", and a bug that swallowed calls while `stats()`
            # reported none dropped would be invisible to the one number an
            # operator watches.
            self._count("dropped_error")
            LOGGER.debug("agent-watch: span dropped", exc_info=True)

    def shutdown(self) -> None:
        """Stop reading spans and let the sender drain what is already queued.

        Idempotent, because a ``TracerProvider`` is shut down both explicitly and
        again from ``atexit``. A second sentinel would be queued after the sender
        had already stopped, and nothing would ever mark it done — so a later
        ``force_flush`` would wait out its whole timeout on a queue that is in
        fact empty.
        """
        if self._stopped.is_set():
            self._worker.join(timeout=self._timeout)

            return

        self._stopped.set()

        try:
            self._queue.put_nowait(_SHUTDOWN)
        except queue.Full:
            pass

        self._worker.join(timeout=self._timeout)

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        """Wait for every queued call to have been sent or dropped.

        ``Queue.join`` has no timeout, so it is waited on from a thread that does.

        :param timeout_millis: How long to wait.
        :returns: ``True`` if the queue drained inside the timeout.
        """
        waiter = threading.Thread(target=self._queue.join, daemon=True)
        waiter.start()
        waiter.join(timeout_millis / 1000)

        return not waiter.is_alive()

    def _run(self) -> None:
        """Drain the queue into batches until shutdown, never letting a failure end the thread."""
        while True:
            batch, taken, done = self._next_batch()

            if batch:
                self._send(batch)

            for _ in range(taken):
                self._queue.task_done()

            if done:
                return

    def _next_batch(self) -> tuple[list[dict[str, Any]], int, bool]:
        """One batch: up to the contract's maximum, or whatever arrived within the flush window.

        :returns: The calls, how many items left the queue (the shutdown sentinel
            is one of them and still owes a ``task_done``), and whether to stop.
        """
        batch: list[dict[str, Any]] = []

        try:
            item = self._queue.get(timeout=self._flush_seconds)
        except queue.Empty:
            # Stopping is decided here as well as by the sentinel, because a full
            # queue has nowhere to put a sentinel. Without this, a shutdown that
            # coincided with a saturated queue and a dead endpoint waited out the
            # whole join timeout — twice, since `atexit` shuts down again.
            return batch, 0, self._stopped.is_set()

        while True:
            if item is _SHUTDOWN:
                return batch, len(batch) + 1, True

            batch.append(item)

            if len(batch) >= BATCH_MAX_CALLS:
                return batch, len(batch), False

            try:
                item = self._queue.get_nowait()
            except queue.Empty:
                return batch, len(batch), False

    def _send(self, batch: list[dict[str, Any]]) -> None:
        """POST one batch, counting a failure as a drop.

        ponytail: a failed batch is dropped, not retried — the queue is the only
        buffer and a retry would hold newer calls behind an endpoint that may be
        down for hours. The ceiling is that a transient blip loses those calls;
        the upgrade path is one bounded retry with backoff before the drop, which
        needs the queue to stay drainable while it waits.
        """
        request = urllib.request.Request(
            self._url,
            data=json.dumps({"calls": batch}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
                "User-Agent": "agent-watch-otel",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                response.read()

            self._count("sent", len(batch))
        except urllib.error.HTTPError as error:
            # The body is not read or logged: a 400 from a strict schema names the
            # field it refused, and the fields this contract exists to refuse are
            # the ones that would carry a prompt.
            error.close()
            self._count("dropped_send_failed", len(batch))
            LOGGER.warning("agent-watch: %d calls dropped, ingest answered %d", len(batch), error.code)
        except Exception:  # noqa: BLE001 - a dead endpoint must not end the sender thread
            self._count("dropped_send_failed", len(batch))
            LOGGER.warning("agent-watch: %d calls dropped, ingest unreachable", len(batch))

    def _count(self, name: str, amount: int = 1) -> None:
        """Add to one counter under the lock that keeps :meth:`stats` consistent."""
        with self._counter_lock:
            self._counters[name] += amount
