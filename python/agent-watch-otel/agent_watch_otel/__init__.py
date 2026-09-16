"""Agent Watch's OpenTelemetry span processor: production LLM spend, as digests only.

One line beside a Phoenix registration sends what Agent Watch needs to price a
call, and nothing that could carry the customer's end-user data::

    from phoenix.otel import register
    from agent_watch_otel import AgentWatchSpanProcessor

    tracer_provider = register(project_name="Production", endpoint=..., batch=True)
    tracer_provider.add_span_processor(AgentWatchSpanProcessor(token="..."))

Phoenix keeps receiving every span exactly as before; this is an additional
processor, never a replacement.
"""

from .call import PLATFORM, build_call, is_llm_span
from .fingerprint import FINGERPRINT_SCHEME, MAX_TOOL_DEPTH
from .processor import AgentWatchSpanProcessor

__all__ = [
    "AgentWatchSpanProcessor",
    "FINGERPRINT_SCHEME",
    "MAX_TOOL_DEPTH",
    "PLATFORM",
    "build_call",
    "is_llm_span",
]

__version__ = "0.1.0"
