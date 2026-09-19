# NanoGPT models

Configure the provider and select a model from its discovery results:

```toml
[providers.nanogpt]
api_key_env = "NANOGPT_API_KEY"

[providers.nanogpt.discovery]
enabled = true
```

```sh
shore provider refresh nanogpt
shore model use nanogpt:google/gemini-flash-latest
```

## Transport and settings

Use `sdk = "nanogpt"` for NanoGPT Gemini models. NanoGPT exposes Gemini
through OpenAI-compatible `/api/v1/chat/completions` with Bearer
authentication; it does not expose the native Google Gemini API. Selecting
`sdk = "gemini"` for the built-in NanoGPT provider now fails during
configuration resolution with a message explaining the supported SDK.
To replace an old saved override, target the model explicitly:

```sh
shore model setting sdk nanogpt --model nanogpt:google/gemini-flash-latest
```

Use `--global` if the bad override is global. Character overrides have
precedence. A bad SDK in provider/catalog TOML needs correction there.

The NanoGPT chat adapter sends `max_tokens`, requests usage with streamed
responses, and sets `Accept: text/event-stream` for streaming calls. These
transport adjustments also apply when the built-in NanoGPT provider uses
the `openai` SDK override. Reasoning off is carried as
`reasoning_effort: "none"`; hiding reasoning output is a separate behavior.
Subscription usage requests normalize both subscription-only and paid-only
base URLs before constructing the usage endpoint.

Only Claude models using the NanoGPT SDK receive Shore's explicit cache
markers and `prompt_caching` helper. Their sticky-provider setting avoids
switching upstream providers away from the cached prefix, but can also
prevent fallback when that provider is unavailable. Gemini and DeepSeek
use NanoGPT's implicit caching; inherited `cache_ttl` settings no longer
inject Claude cache controls into those requests. See
[cache keepalive](CACHE_KEEPALIVE.md) before opting into refresh calls.

Images are sent as OpenAI `image_url` content parts with data URLs. Select
a model whose discovery capabilities include vision. Model names that look
similar can have different capabilities: during this audit, NanoGPT listed
DeepSeek V4 Flash as text-only and V4.1 Flash as supporting images.

## Live audit: issues #216, #217, and #223

On 2026-09-19, bounded requests used Shore's real provider adapters and
`withCallCapture`/wire capture against `https://nano-gpt.com`. The prompts
were synthetic, and the image was a generated solid-red PNG. Captures
redacted credentials; no private conversation was sent.

| Probe | Result |
| --- | --- |
| Gemini Flash, original chat adapter, no explicit caching | Replied successfully; the reported general timeout was not reproduced |
| Gemini Flash, original request plus inherited `1h` Claude cache controls | HTTP 503 with `code: "fallback_blocked_for_cache_consistency"` |
| Gemini Flash, native Google SDK against NanoGPT base URL | HTTP 404 from the nested `/api/v1/v1beta/models/google/...` route |
| Gemini Flash, patched chat adapter with inherited `cache_ttl = "1h"` | Replied successfully; unsupported explicit cache fields omitted |
| DeepSeek V4.1 Flash, original and patched adapters | Both identified the image as red, including patched requests with inherited cache settings |
| Claude Haiku 4.5, explicit `1h` cache, two identical non-streaming calls | First wrote 6,068 tokens; second read 6,068 cached tokens |

The Claude calls reported costs of about $0.012144 and $0.000615,
respectively. They demonstrate immediate cache reuse through the gateway,
including the existing explicit markers and sticky-provider helper. They
do not verify retention for a full hour or across upstream outages.

The Gemini cache-control failure is reproducible, and removing unsupported
controls fixes that request. It does not establish that every historical
Gemini timeout had this cause. Likewise, the original DeepSeek image-loss
symptom was not reproduced on this checkout, which already contains the
image-sizing changes from PR #229. The new local end-to-end regression
test sends a chat attachment through runtime, model resolution, generation,
and the real HTTP adapter, and verifies that the image bytes arrive intact.
An original failing model ID, attachment, and request capture are still
needed to explain a remaining image failure.

Before diagnosis, the required toolchain and dependency updates found the
checkout current: Bun 1.4.2, Rust/Cargo 1.98.1, cargo-edit 0.13.13,
cargo-sweep 0.8.0, OpenAI SDK 7.19.0, and Google GenAI SDK 2.23.0.
The unchanged baseline passed both project verification suites; no
dependency migration was necessary.

Upstream references: [chat completions](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion),
[prompt caching](https://docs.nano-gpt.com/api-reference/miscellaneous/prompt-caching),
[streaming protocol](https://docs.nano-gpt.com/api-reference/miscellaneous/streaming-protocol),
[Gemini integration](https://docs.nano-gpt.com/integrations/gemini-cli), and
[reasoning controls](https://docs.nano-gpt.com/api-reference/miscellaneous/extended-thinking).
