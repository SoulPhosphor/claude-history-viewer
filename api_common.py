"""Small shared helpers for the reusable API-logic modules.

These modules (labels, bulk_labels, snapshots) hold the business/data logic the
HTTP handlers in server.py call. They must not depend on the request handler or
any other HTTP-specific object, so they signal error responses by raising
`ApiError(message, status)`; server.py translates that into a JSON error reply
with the matching status code.
"""
from __future__ import annotations


class ApiError(Exception):
    """A recoverable request error carrying the HTTP status the handler should
    send. Core logic raises it; the HTTP layer catches it and renders the JSON
    ``{"error": message}`` body with ``status``."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status
