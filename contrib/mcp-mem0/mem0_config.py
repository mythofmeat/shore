"""Shared mem0 configuration for the MCP server and the backfill script.

Everything is local except extraction: the embedder runs on CPU via fastembed and
the vector store is an on-disk Qdrant. Only the extraction LLM leaves the machine.
"""

import os
from contextvars import ContextVar


_llm_response = ContextVar("mem0_llm_response", default=None)

DEFAULTS = {
    "llm_model": "deepseek-v4-flash",
    "llm_base_url": "https://api.deepseek.com",
    "embedder": "BAAI/bge-small-en-v1.5",
    "embedder_dims": "384",
    "store": "/data",
}


def env(name: str) -> str:
    return os.environ.get(f"MEM0_{name.upper()}") or DEFAULTS[name]


def api_key() -> str:
    named = os.environ.get("MEM0_LLM_API_KEY_ENV")
    key = os.environ.get(named) if named else os.environ.get("MEM0_LLM_API_KEY")
    if not key:
        raise SystemExit(
            f"{named} is empty" if named else "MEM0_LLM_API_KEY is required"
        )
    return key


def _field(value, name: str):
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _capture_response(_llm, response, _params) -> None:
    choices = _field(response, "choices") or []
    choice = choices[0] if choices else None
    message = _field(choice, "message")
    usage = _field(response, "usage")
    details = _field(usage, "completion_tokens_details")
    _llm_response.set(
        {
            "finish_reason": _field(choice, "finish_reason"),
            "content": _field(message, "content") or "",
            "prompt_tokens": _field(usage, "prompt_tokens"),
            "completion_tokens": _field(usage, "completion_tokens"),
            "reasoning_tokens": _field(details, "reasoning_tokens"),
        }
    )


def begin_llm_diagnostics() -> None:
    _llm_response.set(None)


def llm_diagnostics() -> dict | None:
    return _llm_response.get()


def build_config() -> dict:
    key = api_key()
    store = env("store")
    return {
        "llm": {
            "provider": "openai",
            "config": {
                "model": env("llm_model"),
                "api_key": key,
                "openai_base_url": env("llm_base_url"),
                "temperature": 0,
                "max_tokens": 8192,
                "response_callback": _capture_response,
            },
        },
        "embedder": {
            "provider": "fastembed",
            "config": {
                "model": env("embedder"),
                "embedding_dims": int(env("embedder_dims")),
            },
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "shore",
                "path": f"{store}/qdrant",
                "embedding_model_dims": int(env("embedder_dims")),
                "on_disk": True,
            },
        },
        "history_db_path": f"{store}/history.db",
    }


def build_memory():
    from mem0 import Memory

    # mem0's OpenAI client hijacks any configured key and base_url when
    # OPENROUTER_API_KEY is present in the environment, silently routing
    # extraction to OpenRouter. MEM0_LLM_* is the only thing that should decide
    # where these calls go.
    os.environ.pop("OPENROUTER_API_KEY", None)
    return Memory.from_config(build_config())
