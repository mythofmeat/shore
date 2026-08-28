# mcp-mem0

mem0 as an MCP server, so shore can retrieve and record memories without the
character having to decide to search.

Shore calls `search` before each turn and injects the result as a transient
prompt block; it calls `add` from a background service after each turn. Neither
tool is granted to the character — `McpRegistry.call` resolves against the full
tool surface, while the model's tool list is built separately from
`tools.enabled_tools`, so these stay invisible to it.

## Configuration

| variable | default |
| --- | --- |
| `MEM0_LLM_API_KEY` | required |
| `MEM0_LLM_MODEL` | `deepseek/deepseek-v4-flash` |
| `MEM0_LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `MEM0_EMBEDDER` | `BAAI/bge-small-en-v1.5` |
| `MEM0_EMBEDDER_DIMS` | `384` |
| `MEM0_STORE` | `/data` |
| `MEM0_HOST` / `MEM0_PORT` | `0.0.0.0` / `3000` |

The embedder runs on CPU via fastembed and the vector store is an on-disk
Qdrant, so only extraction leaves the machine. DeepSeek is the default because
Gemini safety-refuses a fifth of this corpus; DeepSeek refuses about 1% after
retries.

Characters are isolated by `user_id`, so one store serves all of them.

## Backfill

`backfill.py` imports history from shore's archive a slice at a time and keeps a
cursor, so it can be run repeatedly without redoing work.

    python backfill.py --history /data/shore-data/history.db --character qifei --from 2026-07-12 --to 2026-08-01

`--reembed <memories.json>` loads already-extracted memories instead of running
extraction again, which is how an existing store is migrated to a new embedder.

## Deployment

Alongside the other MCP services in `compose.yaml`:

```yaml
  mcp-mem0:
    container_name: mcp-mem0
    build: ./contrib/mcp-mem0
    init: true
    user: "1000:1000"
    environment:
      - TZ=${TZ}
      - MEM0_LLM_API_KEY=${DEEPSEEK_API_KEY}
      - MEM0_LLM_BASE_URL=https://api.deepseek.com
      - MEM0_LLM_MODEL=deepseek-chat
    volumes:
      - ./data/mem0:/data
    restart: unless-stopped
```

and in shore's config:

```toml
[mcp.mem0]
url = "http://mcp-mem0:3000/mcp"

[memory.recall]
mode = "inject"
server = "mem0"
```

Do **not** add `mcp__mem0__*` to any character's `tools`. The daemon calls these
itself; granting them would put the tools back in the model's hands, which is the
problem this exists to solve.

`HOME` is set to `/data` because mem0 keeps an internal migrations store under
`$HOME/.mem0`. It must be writable and on the volume, or the container loses it
on restart. That store takes a file lock, as does the main one — embedded Qdrant
is single-process, which is why `backfill.py` talks to the server rather than
opening the store itself.
