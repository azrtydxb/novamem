"""Async twins of Client, Management and Admin.

Each method runs its sync counterpart in a worker thread
(``asyncio.to_thread``), so the async classes share every rule of the sync
ones with no second implementation to drift. Cancelling the awaiting task
raises ``asyncio.CancelledError`` as usual — it is never converted, so
``asyncio.timeout()`` and ``TaskGroup`` keep working; the abandoned request
itself still ends within the client's timeout.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
from collections.abc import Callable
from typing import Any

from ._client import Admin, Client, Management, _Base


def _async_method(name: str, sync: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(sync)
    async def method(self: _AsyncBase, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(getattr(self._sync, name), *args, **kwargs)

    return method


class _AsyncBase:
    _SYNC: type[_Base]

    def __init__(self, base_url: str, token: str, **kwargs: Any) -> None:
        self._sync = self._SYNC(base_url, token, **kwargs)

    def __repr__(self) -> str:
        return "Async" + repr(self._sync)

    def __init_subclass__(cls, **kw: Any) -> None:
        super().__init_subclass__(**kw)
        for name, fn in inspect.getmembers(cls._SYNC, inspect.isfunction):
            if not name.startswith("_"):
                setattr(cls, name, _async_method(name, fn))


class AsyncClient(_AsyncBase):
    """Async :class:`Client`."""

    _SYNC = Client


class AsyncManagement(_AsyncBase):
    """Async :class:`Management`."""

    _SYNC = Management


class AsyncAdmin(_AsyncBase):
    """Async :class:`Admin`."""

    _SYNC = Admin
