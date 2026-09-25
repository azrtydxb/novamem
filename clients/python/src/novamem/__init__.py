"""Python client for novamem, a tiered memory service for agents.

from novamem import Client, CaptureRequest, SearchRequest, UnavailableError

c = Client("https://novamem.example.com", token)
c.capture(CaptureRequest(content="User prefers dark roast"))
try:
    hits = c.search(SearchRequest(query="coffee preference", k=5))
except UnavailableError:
    ...  # "I could not look." Say so; do not claim ignorance.
else:
    if not hits.results:
        ...  # "Nothing is stored about that." This one is knowledge.
"""

from ._async import AsyncAdmin, AsyncClient, AsyncManagement
from ._client import Admin, Client, Management
from ._errors import ConfigError, NotFoundError, NovamemError, UnavailableError
from ._transport import DEFAULT_TIMEOUT, MAX_RESPONSE_BYTES
from ._types import *  # the generated wire types are the public API
from ._types import __all__ as _types_all

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_TIMEOUT",
    "MAX_RESPONSE_BYTES",
    "Admin",
    "AsyncAdmin",
    "AsyncClient",
    "AsyncManagement",
    "Client",
    "ConfigError",
    "Management",
    "NotFoundError",
    "NovamemError",
    "UnavailableError",
]
__all__.extend(_types_all)
