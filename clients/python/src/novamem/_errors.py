"""The error contract (ADR 0009, transcribed from clients/go).

The one question every caller must be able to answer is "could the store
be consulted?". ``UnavailableError`` means no: a refused dial, a timeout, a
5xx, a 429, or a body that is not the JSON the API promises. Any other
``NovamemError`` is a real answer that was not success — a rejected token,
a bad request, an id that is not in your scope (``NotFoundError``). An empty
result with no exception is the only thing this SDK ever presents as
"nothing is stored".
"""

from __future__ import annotations


class ConfigError(ValueError):
    """The client was constructed with a missing or unusable setting."""


class NovamemError(Exception):
    """Every failure of a call. Never contains the bearer token."""

    def __init__(
        self,
        op: str,
        message: str,
        *,
        status_code: int = 0,
        code: str = "",
        unavailable: bool = False,
        retryable: bool = False,
    ) -> None:
        #: The client method that failed ("search", "remove-member", …).
        self.op = op
        #: The HTTP status, or 0 when no response was received.
        self.status_code = status_code
        #: The server's machine-readable error code, when it sent one.
        self.code = code
        #: The server's message, or a description of the transport failure.
        self.message = message
        #: True when the store could not be consulted.
        self.unavailable = unavailable
        #: True when calling again could plausibly succeed. This SDK never
        #: retries for you: the budget belongs to the caller.
        self.retryable = retryable
        super().__init__(str(self))

    def __str__(self) -> str:
        s = f"novamem {self.op}"
        if self.status_code:
            s += f": {self.status_code}"
        if self.code:
            s += f" [{self.code}]"
        if self.message:
            s += f": {self.message}"
        return s

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(op={self.op!r}, status_code={self.status_code}, "
            f"code={self.code!r}, message={self.message!r}, retryable={self.retryable})"
        )


class UnavailableError(NovamemError):
    """The store could not be consulted. Say so; do not claim ignorance."""

    def __init__(self, op: str, message: str, **kw: object) -> None:
        kw.setdefault("unavailable", True)
        super().__init__(op, message, **kw)  # type: ignore[arg-type]


class NotFoundError(NovamemError):
    """The store answered: that id is not in your scope."""
