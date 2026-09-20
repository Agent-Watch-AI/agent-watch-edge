"""A local HTTP sink that keeps every request body verbatim.

Verbatim matters: the canary reads the raw bytes, not a parsed payload, so a
prompt smuggled into a key, a header or a field nobody thought to check is still
found.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class Sink:
    """An ingest endpoint on localhost, recording what reaches it.

    :param status: The HTTP status to answer with, so a test can be a healthy
        endpoint or a refusing one.
    """

    def __init__(self, status: int = 202) -> None:
        self.bodies: list[bytes] = []
        self.headers: list[dict[str, str]] = []
        self._status = status
        self._lock = threading.Lock()
        sink = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)

                with sink._lock:
                    sink.bodies.append(body)
                    sink.headers.append(dict(self.headers))

                self.send_response(sink._status)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args: Any) -> None:
                """Silence the default stderr access log."""

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def endpoint(self) -> str:
        """The base URL a processor is pointed at."""
        host, port = self._server.server_address[:2]

        return f"http://{host}:{port}"

    def calls(self) -> list[dict[str, Any]]:
        """Every call across every batch received, in arrival order."""
        with self._lock:
            return [call for body in self.bodies for call in json.loads(body)["calls"]]

    def close(self) -> None:
        """Stop serving."""
        self._server.shutdown()
        self._server.server_close()

    def __enter__(self) -> "Sink":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
