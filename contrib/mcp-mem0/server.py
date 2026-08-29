"""MCP server exposing mem0 search and add, one memory space per shore character.

Shore calls these tools programmatically rather than granting them to the model,
so the character never sees them in its tool surface.
"""

import os
import threading

from mcp.server.mcpserver import MCPServer

from mem0_config import build_memory

mcp = MCPServer("mem0")

_memory = None
_lock = threading.Lock()


def memory():
    global _memory
    with _lock:
        if _memory is None:
            _memory = build_memory()
        return _memory


def _results(raw) -> list:
    return raw.get("results", raw) if isinstance(raw, dict) else raw


@mcp.tool()
def search(query: str, character: str, limit: int = 6) -> dict:
    """Retrieve memories relevant to a query for one character."""
    if not query.strip():
        return {"memories": []}
    raw = memory().search(query=query, filters={"user_id": character}, limit=limit)
    return {
        "memories": [
            {
                "text": item.get("memory"),
                "score": item.get("score"),
                "occurred_at": (item.get("metadata") or {}).get("ts"),
            }
            for item in _results(raw)
            if item.get("memory")
        ]
    }


@mcp.tool()
def add(
    messages: list,
    character: str,
    metadata: dict | None = None,
    infer: bool = True,
) -> dict:
    """Extract and store memories from a run of conversation messages.

    With infer=False the messages are stored verbatim, which is how an already
    extracted store is re-embedded without paying for extraction again.
    """
    if not messages:
        return {"added": 0}
    last = None
    for attempt in range(3):
        try:
            raw = memory().add(
                messages=messages,
                user_id=character,
                metadata=metadata or {},
                infer=infer,
            )
            return {"added": len(_results(raw) or [])}
        except Exception as error:
            last = error
    raise RuntimeError(f"mem0 add failed after 3 attempts: {last}")


if __name__ == "__main__":
    mcp.run(
        transport="streamable-http",
        host=os.environ.get("MEM0_HOST", "0.0.0.0"),
        port=int(os.environ.get("MEM0_PORT", "3000")),
    )
