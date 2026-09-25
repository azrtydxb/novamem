"""One function makes every request, so the classification of failures is
written exactly once."""

from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from ._errors import ConfigError, NotFoundError, NovamemError, UnavailableError

#: Bounds a single call when no timeout is given. Sized for the slowest
#: operation: capture embeds the content server-side before it answers.
DEFAULT_TIMEOUT = 15.0

#: Responses larger than this are rejected rather than buffered: a rogue
#: endpoint must not be able to make the caller allocate without bound.
MAX_RESPONSE_BYTES = 8 << 20


class Transport:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        opener: urllib.request.OpenerDirector | None = None,
    ) -> None:
        base = (base_url or "").strip().rstrip("/")
        parts = urllib.parse.urlsplit(base)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            # Names the field, never the value: a token pasted into the
            # wrong argument must not end up in a log line.
            raise ConfigError("novamem: base_url is not an absolute http(s) URL")
        if not (token or "").strip():
            raise ConfigError("novamem: token is required")
        self.base_url = base
        self._token = token
        self.timeout = timeout if timeout and timeout > 0 else DEFAULT_TIMEOUT
        self._opener = opener or urllib.request.build_opener(_SameOriginAuth())

    def __repr__(self) -> str:
        return f"Transport(base_url={self.base_url!r}, token=[redacted], timeout={self.timeout})"

    def _redact(self, s: str) -> str:
        return s.replace(self._token, "[redacted]")

    def call(
        self,
        op: str,
        method: str,
        path: str,
        body: Any = None,
        *,
        query: dict[str, Any] | None = None,
        expect_body: bool = True,
    ) -> Any:
        """Performs one request and returns the decoded JSON body (or None
        when ``expect_body`` is False). Raises NovamemError on anything else.

        The timeout bounds each socket operation (connect, and every read),
        which is what the standard library offers; a server that answers a
        byte at a time can stretch a call beyond it.
        """
        url = self.base_url + path
        q = {k: v for k, v in (query or {}).items() if v is not None and v != ""}
        if q:
            url += "?" + urllib.parse.urlencode({k: _qs(v) for k, v in q.items()})
        headers = {
            "Accept": "application/json",
            "Authorization": "Bearer " + self._token,
        }
        data = None
        if body is not None:
            data = json.dumps(body, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)

        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                status, raw = resp.status, resp.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as e:
            try:
                raw = e.read(MAX_RESPONSE_BYTES + 1)
            except (OSError, http.client.HTTPException):
                raw = b""
            finally:
                e.close()
            raise self._http_error(op, e.code, raw) from None
        except urllib.error.URLError as e:
            if isinstance(e.reason, TimeoutError):
                raise UnavailableError(op, "timed out", retryable=True) from None
            raise UnavailableError(
                op, self._redact(f"unreachable: {e.reason}"), retryable=True
            ) from None
        except TimeoutError:
            raise UnavailableError(op, "timed out", retryable=True) from None
        except (OSError, http.client.HTTPException) as e:
            # Reset connection, a server that closed without answering, a
            # truncated read: the host could not be consulted.
            raise UnavailableError(
                op, self._redact(f"unreachable: {e!r}"), retryable=True
            ) from None

        if len(raw) > MAX_RESPONSE_BYTES:
            raise UnavailableError(
                op, "response body exceeds 8 MiB", status_code=status
            )
        if not expect_body:
            return None
        if not raw.strip():
            # A 2xx with no body is not the contract. Decoding it into a
            # default would tell a forget caller the delete happened.
            raise UnavailableError(op, "empty response body", status_code=status)
        try:
            return json.loads(raw)
        except ValueError:
            # In practice a proxy's HTML error page or a truncated response:
            # we never reached a working novamem. Not retryable — the same
            # request parses the same way.
            raise UnavailableError(
                op, "malformed response body", status_code=status
            ) from None

    def _http_error(self, op: str, status: int, raw: bytes) -> NovamemError:
        message, code = "", ""
        try:
            payload = json.loads(raw)
            if isinstance(payload, dict) and payload.get("error"):
                message = str(payload["error"])
                code = str(payload.get("code") or "")
        except ValueError:
            pass
        if not message:
            text = raw.decode("utf-8", "replace").strip()
            message = text[:256] + "…" if len(text) > 256 else text
        # The server's message and code are quoted verbatim, and a server that
        # echoes the credential back ("bad token nm_…") would otherwise
        # launder it into this client's logs.
        message = self._redact(message)
        code = self._redact(code)
        if status >= 500 or status == 429:
            return UnavailableError(
                op, message, status_code=status, code=code, retryable=True
            )
        if status == 404:
            return NotFoundError(op, message, status_code=status, code=code)
        return NovamemError(op, message, status_code=status, code=code)


class _SameOriginAuth(urllib.request.HTTPRedirectHandler):
    """Follows redirects, but never carries the bearer to another origin.

    urllib's default handler copies every header onto the redirected
    request, so a redirect to a different host would hand it the token. Go's
    http.Client drops Authorization on a cross-origin redirect; so does this.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and _origin(new.full_url) != _origin(req.full_url):
            new.remove_header("Authorization")
        return new


def _origin(url: str) -> tuple[str, str]:
    p = urllib.parse.urlsplit(url)
    return (p.scheme, p.netloc.lower())


def _qs(v: Any) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)
