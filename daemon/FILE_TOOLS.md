# File tools

Shore exposes `read`, `edit`, and `apply_patch` alongside `bash`. The model chooses which tools to use. There is no read-before-edit requirement. Paths may be absolute or relative to the character's workspace; symlinks and access outside the workspace follow the daemon user's host permissions, as with Bash.

## Configuration

New starter configurations enable all three tools. Existing configurations retain their explicit tool lists. Add the tools you want in `config.toml`:

```toml
[tools]
enabled = ["bash", "read", "edit", "apply_patch", "search", "search_chat_logs"]

[tools.read]
max_result_chars = 50000
max_inline_image_bytes = 5242880

[tools.apply_patch]
timeout = "1m"
```

The same allowlist works for every provider. Subagents use their own configured tool lists. A model call to a tool absent from its advertised tool set is rejected before dispatch. Explicit `shore debug tool` invocations can still run disabled tools. Dry-run contexts reject edits, patches and shell commands.

Model settings accept `supports_images = false` for text-only models or endpoints. Shore also uses discovered image capability and its existing learned rejection cache. On each model continuation, unavailable images become explicit error notices and a provider warning; the original structured results remain in history. An HTTP image-support rejection before output retries that individual request once with notices, without repeating tool execution. Other provider errors propagate normally. Claude Agent uses its native SDK session; Shore does not replay a native session after a provider failure.

## Reading

```json
{"file_path":"notes.txt","offset":1,"limit":100}
```

`file_path` can also be a wikilink copied from a Markdown file, such as `[[harbor-district]]`, `[[city/locations/market|the market]]` or `![[portrait.png]]`. A note's name is its file name without `.md`, and a picture's is its PNG, JPEG, WebP or GIF file name, with the extension in any case. `[[...]]` names a note, unless it ends in a picture extension; `![[...]]` names a picture, with or without its extension, and opens the note of that name when no picture has it. Names match exactly, including case. Folders written in front must be the folders directly above the file, and a leading `/` anchors the link at the workspace root. Text from `|` or `#` on is ignored. The whole workspace is searched except `.git` and symlinks. Notes in hidden folders, hidden notes, and all-caps notes such as `README.md` or `MEMORY.md` have no name and are read by path. A plain `file_path` is a path first. Only when a path inside the workspace does not exist, or is a folder, is it tried as a name: a picture if it ends in a picture extension, a note otherwise. The result then ends with a line saying which link it was found as. When more than one file fits, the read fails and lists every one as the link with the fewest folders that picks it, falling back to the anchored full path; when none fits, it suggests up to five of the closest names, ignoring case. The result still begins with the file's real path, which is what `edit` and `apply_patch` take; they do not look up names.

Text is UTF-8, numbered from line 1. Defaults are offset 1 and at most 2,000 lines. Lines longer than 2,000 characters are explicitly shortened. The configured result-character budget can shorten the page further; the result states EOF or the next offset. Even a configured unlimited result budget retains a 50,000-character read budget. Empty files, offsets beyond EOF, unsupported binary data, invalid encodings, directories and access failures receive explicit results or errors.

PNG, JPEG, WebP and GIF files become real model image content, not JSON or base64 text. Image reads do not accept offset or limit. Source images are capped at 64 MiB. An image file over 5 MiB is first reduced to the full resolution any model is sent (4,784 image tokens, at most 3,750,000 bytes), and that copy takes the file's place: it is the saved media copy, the image clients are shown, and the source of what the model receives. Shared media preparation limits each delivered image to a 2,000-pixel longest edge and 1,000,000 base64 characters, resizing or converting as needed. GIF delivery uses the first frame. Generic tool results, including MCP results, may contain text and images. At most 20 images are sent per result, and `tools.max_inline_image_bytes` caps their total size, defaulting to 5 MiB (5,242,880 bytes). Override it per tool, for example with `tools.read.max_inline_image_bytes`; zero disables inline image delivery. The budget counts decoded bytes after resizing or conversion, which is what the model receives. Images are considered in order; one that does not fit is listed in a single note as not sent, is still saved and shown to clients, and does not fail the result, so later smaller images can still be sent. A failure to prepare an image for delivery marks the result as an error. A failure to save an auxiliary media copy does not prevent image delivery. Each model request carries at most the newest 100 image blocks, up to 20,000,000 base64 characters in total; older images become omission notices in that request and remain in history. Older images are dropped in batches of 50 images or 10,000,000 base64 characters, so the dropped prefix, and the provider's prompt cache, stay the same until history grows by another batch.

Markdown reads expand unique local image references fully visible on the returned page, then deliver them under the same per-result limits. Paths resolve relative to the Markdown file, and duplicate paths count only once. Wikilink embeds such as `![[name.png]]`, `![[name]]` or `![[folder/name.png|alt]]` find a picture by name with the rules above, even when the Markdown file is outside the workspace. An embed that names a note stays text. One that matches no picture or note is reported with up to five close picture names, and one that matches more than one picture is reported with a link for each, the first three named; either way it is skipped. A size option such as `|300` is ignored; other text after `|` labels the image. Only the first 20 unique references are read. Missing, invalid, or oversized images are reported without failing the text read; the first three are named and the rest counted. These notes follow the numbered page, so they never displace it. Markdown source scanning is capped at 1 MiB.

PDF and notebook rendering are not implemented. Images consume model context and the API may impose additional limits.

## Exact replacement

```json
{"file_path":"notes.txt","old_string":"old text","new_string":"new text","replace_all":false}
```

The existing file must contain the exact old text, including whitespace and line endings. A unique match is required unless `replace_all=true`, which replaces all non-overlapping matches. Empty old text, identical replacements, absent matches and ambiguous matches are errors. Empty new text deletes the match. Validation errors leave the file unchanged. UTF-8 BOM and untouched line endings are preserved. Host write failures can leave partial changes; simultaneous external writers are not locked out.

## Native contextual patches

```json
{"patch":"*** Begin Patch\n*** Update File: notes.txt\n@@\n unchanged line\n-old text\n+new text\n*** End Patch"}
```

This uses the unchanged `codex-rs/apply-patch` executable and its native format, including Add File, Delete File, Update File, Move to, contextual hunks and End of File markers. It is not a unified-diff parser. Codex's context and whitespace matching, symlink behavior, and default line-ending normalization apply. Native application is sequential: later failure or cancellation may leave earlier changes. Error results explicitly warn about this. Prompt-file reload tracking also runs after partial failures. Standard unified diffs can be applied through Bash with `git apply`.

A Rust executable avoids maintaining a second implementation of Codex's matching and patch grammar. The harness stays in TypeScript. The build fetches the revision in `vendor/codex-apply-patch/source.json`, verifies its SHA-256, and builds with the committed Cargo lockfile. That lockfile records resolution needed by the current stable Cargo; upstream source code is unchanged. The upstream Apache-2.0 LICENSE and NOTICE are included in `vendor/` and copied beside release artifacts.

```sh
cd daemon
bun install
bun run build:patch
bun run build
```

Building requires the stable Rust toolchain via rustup, Cargo, tar, a native C/C++ build toolchain, OpenSSL development libraries (including static libraries for musl), and network access for the first build. Source and build caches live in `$XDG_CACHE_HOME/shore/codex-apply-patch` (default `~/.cache/shore/codex-apply-patch`), shared by every checkout. The executable is `daemon/dist/shore-apply-patch`; distribute it and its LICENSE/NOTICE beside `shore-daemon`. Source development also locates it in `dist/`. `bun test` runs this build before the native patch tests, so running the tests needs the same toolchain. Alternatively set `SHORE_APPLY_PATCH_PATH` to an absolute executable path. `SHORE_PATCH_TARGET_DIR` can select a build-artifact cache. The Dockerfile builds and installs the helper in its own stage. A missing helper gives an actionable tool error and performs no patching.

## Manual checks

With the daemon running and a selected character, use disposable files:

```sh
shore debug tool bash 'command=printf "first\nold\nlast\n" > tool-demo.txt'
shore debug tool read file_path=tool-demo.txt offset=2 limit=1
shore debug tool edit file_path=tool-demo.txt old_string=old new_string=new
shore debug tool edit file_path=tool-demo.txt old_string=absent new_string=unexpected
shore debug tool apply_patch --input '{"patch":"*** Begin Patch\n*** Update File: tool-demo.txt\n@@\n-new\n+patched\n*** End Patch"}'
shore debug tool read file_path=tool-demo.txt
```

The missing-match edit should fail with the file unchanged. For image delivery, enable `read`, select a vision model, and ask it to read an existing PNG and describe a visual detail. A debug-tool result verifies dispatch; a model conversation verifies visual interpretation. Repeat with `supports_images=false` to see an explicit warning and tool error notice while the conversation continues. Switch back to a vision model and replay the stored result to verify the original image remains available.

## Provider formats and references

The payload tests capture requests after the installed SDK has serialized them. These tests verify shape and association, not live model recognition or account-specific endpoint support.

| Adapter / endpoint | Tool images |
| --- | --- |
| Anthropic Messages | Image blocks inside the matching `tool_result` |
| Claude Agent | MCP image content returned to the SDK's matching tool invocation |
| OpenAI and NanoGPT Chat Completions | Text tool responses first, then a user image message labeling each source tool name and call ID |
| Z.ai Chat Completions | The same labeled user image bridge, for vision-capable models/endpoints |
| OpenRouter, DeepSeek, Moonshot via AI SDK | The same bridge, verified in serialized HTTP payloads |
| Gemini generateContent, generation 3+ | `functionResponse.parts[].inlineData` with function name and call ID |
| Older Gemini generateContent | Adjacent inline image parts with source labels |

New structured history clients advertise `multimodal-tool-results`. Clients without it receive readable text projections without base64 image dumps. The canonical Rust schema supports image blocks and string-or-block tool results.

References checked against installed SDKs and official documentation:

- [Claude Code Read and Edit](https://code.claude.com/docs/en/tools-reference)
- [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Gemini generateContent function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling)
- [NanoGPT Chat Completions](https://docs.nano-gpt.com/api-reference/endpoint/chat-completion)
- [OpenRouter images](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [Moonshot/Kimi vision](https://platform.kimi.ai/docs/guide/use-kimi-vision-model)
- [Z.ai Chat Completions](https://docs.z.ai/api-reference/llm/chat-completion)
- [Pinned Codex apply-patch source](https://github.com/openai/codex/tree/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/apply-patch)
