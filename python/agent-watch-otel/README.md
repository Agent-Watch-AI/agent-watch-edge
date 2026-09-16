# agent-watch-otel

**Your production LLM spend in Agent Watch, hashed in your own process.**

One line beside your Phoenix registration. Prompt text, tool arguments and model responses never
leave the process — only digests, token counts and ids do. Phoenix keeps receiving everything,
unchanged.

```bash
pip install agent-watch-otel
```

```python
from phoenix.otel import register
from agent_watch_otel import AgentWatchSpanProcessor

tracer_provider = register(project_name="Production", endpoint=..., batch=True)
tracer_provider.add_span_processor(AgentWatchSpanProcessor(token="..."))  # beside yours
```

The token is an Agent Watch SDK token scoped `ingest:production`. `token` and `endpoint` may also
come from `AGENT_WATCH_TOKEN` and `AGENT_WATCH_ENDPOINT`.

---

## What it sends

Finished spans whose `openinference.span.kind` is `LLM`, and nothing else. Per call:

| Sent | Not sent |
|---|---|
| sha256 of the system/developer prefix, and its 8-token window digests | the prompt |
| sha256 of the tool definitions | the tool definitions, and every tool argument |
| model, provider, token counts (input, output, cache read/write, reasoning) | the response |
| span id, trace id, span name, end time | anything the span carries that is not in this table |
| `service.name` and `service.version` from the OTel resource | |

That last row is why this package exists rather than only the poller: **Phoenix drops resource
attributes at ingest**, so a span processor is the only thing that can report which service and
which version produced a call.

Digests are computed in `on_end`, on your thread, before anything is queued. The queue holds
hashes; the sender thread never sees a prompt.

## What it does to your application

Nothing you can measure, and nothing you can trip over.

- **`on_end` never touches the network.** It hashes and enqueues. A background daemon thread
  batches and POSTs.
- **`on_end` never raises.** Every path out of it is wrapped. A bug here costs you a cost record,
  never a request.
- **The queue is bounded.** When Agent Watch is unreachable or slow, calls are dropped and counted
  rather than buffered without limit inside your process.
- **It survives `fork()`.** Under gunicorn `--preload`, uWSGI or Celery prefork, each child gets
  its own sender thread rather than silently dropping every call.
- **Shutting down is bounded.** An endpoint that accepts the connection and never answers cannot
  stretch `shutdown()` past `shutdown_seconds`, however many times it is called — so stopping
  your process stays inside a short `SIGTERM` grace period. Call `force_flush()` instead when
  what you want is delivery rather than a prompt exit.

```python
processor.stats()
# {'sent': 412, 'dropped_queue_full': 0, 'dropped_send_failed': 3,
#  'dropped_no_model': 0, 'dropped_error': 0}
processor.dropped   # 3
```

A call with no `llm.model_name` and no `llm.model` is counted under `dropped_no_model` rather than
sent under a guessed model, because spend priced against the wrong model is worse than spend that
is visibly missing.

## Options

| Argument | Default | What it is |
|---|---|---|
| `token` | `$AGENT_WATCH_TOKEN` | SDK token scoped `ingest:production` |
| `endpoint` | `$AGENT_WATCH_ENDPOINT` | Ingest base URL; the route is `v1/runtime/calls` |
| `instance_id` | the resource's `service.name` | This deployment's name, as you know it |
| `max_queue` | 2048 | Calls held while the sender is behind |
| `flush_seconds` | 5.0 | How long a partial batch waits |
| `timeout_seconds` | 10.0 | Network timeout for one POST |
| `shutdown_seconds` | 3.0 | The whole budget `shutdown()` may spend, across every call |

A missing token or endpoint raises at construction — on your startup path, where a misconfiguration
is visible — never later from `on_end`.

## Requirements

Python 3.9+ and `opentelemetry-sdk`. Nothing else, by policy: this code runs inside your
application, so every dependency it took would become a version you have to resolve.

## Development

```sh
python -m venv .venv && .venv/bin/pip install opentelemetry-sdk
.venv/bin/python -m unittest              # the whole suite
.venv/bin/python -m unittest tests.test_vectors   # the fingerprint parity check
```

`tests/vectors.json` is a byte copy of core's golden fingerprint vectors
(`packages/fingerprint/test/vectors.json`, AWT-263). `tests/test_vectors.py` replays every case
through this port, so the two implementations cannot drift apart without CI going red. It also
covers a case no shared vector can express — see `MAX_TOOL_DEPTH` in `agent_watch_otel/fingerprint.py`.

## Licence

MIT.
