"""MCP server exposing mem0 search and add, one memory space per shore character.

Shore calls these tools programmatically rather than granting them to the model,
so the character never sees them in its tool surface.
"""

import json
import os
import threading

from mcp.server.mcpserver import MCPServer

from mem0_config import begin_llm_diagnostics, build_memory, llm_diagnostics

mcp = MCPServer("mem0")

_memory = None
_lock = threading.Lock()
_add_attempts = int(os.environ.get("MEM0_ADD_ATTEMPTS", "1"))
if _add_attempts < 1 or _add_attempts > 3:
    raise ValueError("MEM0_ADD_ATTEMPTS must be between 1 and 3")


def memory():
    global _memory
    with _lock:
        if _memory is None:
            _memory = build_memory()
        return _memory


def _results(raw) -> list:
    return raw.get("results", raw) if isinstance(raw, dict) else raw


def _json_object(content: str) -> dict | None:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        value = json.loads(text, strict=False)
    except (TypeError, ValueError):
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            value = json.loads(text[start : end + 1], strict=False)
        except (TypeError, ValueError):
            return None
    return value if isinstance(value, dict) else None


def _add_diagnostic(results: list, infer: bool) -> dict:
    if not infer:
        return {"extraction": "disabled"}

    captured = llm_diagnostics()
    if not captured:
        return {"empty_reason": "diagnostic_unavailable"} if not results else {}

    diagnostic = {
        key: captured.get(key)
        for key in (
            "finish_reason",
            "prompt_tokens",
            "completion_tokens",
            "reasoning_tokens",
        )
        if captured.get(key) is not None
    }
    if results:
        return diagnostic

    if captured.get("provider_response") is not None:
        diagnostic["provider_response"] = captured["provider_response"]

    content = captured.get("content") or ""
    if captured.get("finish_reason") == "length":
        diagnostic["empty_reason"] = "model_hit_token_limit"
        return diagnostic
    if captured.get("finish_reason") == "content_filter":
        diagnostic["empty_reason"] = "model_content_filtered"
        return diagnostic
    if captured.get("refusal"):
        diagnostic["empty_reason"] = "model_refused"
        return diagnostic
    if not content.strip():
        diagnostic["empty_reason"] = "model_returned_empty_content"
        return diagnostic

    parsed = _json_object(content)
    candidates = parsed.get("memory") if parsed is not None else None
    if isinstance(candidates, list):
        diagnostic["candidate_count"] = len(candidates)
        if not candidates:
            diagnostic["empty_reason"] = "model_extracted_no_memories"
        else:
            diagnostic["empty_reason"] = "mem0_filtered_all_candidates"
            diagnostic["candidates"] = [
                str(candidate.get("text") or candidate)
                if isinstance(candidate, dict)
                else str(candidate)
                for candidate in candidates
            ]
        return diagnostic

    diagnostic["empty_reason"] = "model_response_unparseable"
    diagnostic["response_preview"] = content[:500]
    return diagnostic


def _safe_add_diagnostic(results: list, infer: bool) -> dict:
    try:
        return _add_diagnostic(results, infer)
    except Exception as error:
        diagnostic = {"diagnostic_error": f"{type(error).__name__}: {str(error)[:200]}"}
        if not results:
            diagnostic["empty_reason"] = "diagnostic_unavailable"
        return diagnostic


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
        return {
            "added": 0,
            "memories": [],
            "diagnostic": {"empty_reason": "no_input_messages"},
        }
    last = None
    for _attempt in range(_add_attempts):
        try:
            begin_llm_diagnostics()
            raw = memory().add(
                messages=messages,
                user_id=character,
                metadata=metadata or {},
                infer=infer,
            )
        except Exception as error:
            last = error
            continue
        break
    else:
        raise RuntimeError(f"mem0 add failed after {_add_attempts} attempt(s): {last}")

    results = [item for item in (_results(raw) or []) if isinstance(item, dict)]
    return {
        "added": len(results),
        "memories": [item["memory"] for item in results if item.get("memory")],
        "diagnostic": _safe_add_diagnostic(results, infer),
    }


if __name__ == "__main__":
    mcp.run(
        transport="streamable-http",
        host=os.environ.get("MEM0_HOST", "0.0.0.0"),
        port=int(os.environ.get("MEM0_PORT", "3000")),
    )
