# Matrix ↔ TUI parity roadmap

Goal: make the Matrix client experience match the TUI as closely as the
Matrix protocol allows. Ordered by implementation sequence — bug fixes and
quick wins first, then the id-map foundation, then the features that build
on it.

## Phase 1 — quick wins / bug fixes

- [x] **Typing keepalive.** Typing notice expires ~4s after `StreamStart`
  (matrix-sdk `TYPING_NOTICE_TIMEOUT`); nothing refreshes it, so long
  generations look stalled. Refresh on every `StreamChunk` in both
  `route_mirror` and `ResponseCollector::feed` — the SDK debounces to one
  request per 3s, so per-chunk calls are cheap.
- [x] **Fix `!alt`.** Falls through to the daemon as `{"text": ...}` today,
  which the `alt` command can't parse — alternatives are unreachable from
  Matrix. Translate: `!alt` → `list_alternatives`, `!alt next|prev` →
  `alt {direction}`, `!alt <n>` → `alt {position}`, optional leading ref.
  Update `!help`.
- [x] **Stop forwarding Matrix edit fallbacks as new messages.** An Element
  edit arrives as an `m.text` event with body `* corrected text` and an
  `m.replace` relation; `on_room_message` ignores the relation and forwards
  the fallback as a brand-new prompt. Detect replacements and route them
  properly (full edit support in Phase 3; at minimum they must not
  double-send).

## Phase 2 — rendering polish

- [x] **Pretty command output.** `CommandOutput` is dumped as pretty-printed
  JSON in a code block. Render the known commands (`status`,
  `list_characters`, `list_models`, `model_settings`, `memory`,
  `list_alternatives`, `alt`, `log`) as Markdown (`src/render.rs`); fall
  back to the code block for unknown ones.
- [x] **Warnings as notices.** `UsageWarning` / `CacheWarning` /
  `ProviderFallbackWarning` frames are dropped. Post them as `m.notice`
  (dimmed, no push notification). Errors and bridge-local replies also
  moved to notices.

## Phase 3 — event map + native edit/delete (the foundation)

- [x] **`event_id ↔ msg_id` map.** Persist `(room, event_id) ↔ msg_id`
  (bounded per room) in a JSON sidecar next to the matrix store
  (`bridge-event-map.json`). Populated from assistant posts and the
  self-echo queue (Matrix event_id ↔ echo `NewMessage(UserInput)` msg_id).
  The daemon's `resolve_ref` accepts literal msg_ids, so mapped ids are
  used directly as command refs.
- [x] **Inbound edits.** User edits their Matrix message → SWP
  `edit {ref: <mapped msg_id>, content}`. Unmapped target → notice.
- [x] **Inbound redactions.** User redacts a mapped message → SWP
  `delete {refs: <msg_id>}`.
- [x] **Outbound mutations.** Implemented as three complementary paths:
  regen-in-place (a fresh `AssistantReply` with ≥2 alternatives replaces
  the room's latest reply via `m.replace`), bridge-initiated `delete`/`alt`
  outputs (targeted redaction / in-place alt swap), and History-snapshot
  diffing for other-client mutations (TUI `:edit`/`:alt` → in-place edit of
  bot-authored events). Disappeared messages only drop their mapping —
  deletion and compaction are indistinguishable in a History snapshot, so
  never redact from a diff. Handshake history runs the same reconciliation
  to catch up after bridge downtime.

## Phase 4 — streaming

- [x] **Progressive message edits while streaming.** First text chunk posts a
  message ending in a ▌ cursor; subsequent chunks throttle-edit it (1.5s
  cadence). The daemon persists before `StreamEnd`, so the reply's
  `NewMessage` arrives mid-stream and *adopts* the streamed event (final
  edit + msg_id mapping) instead of posting a duplicate; `StreamEnd` then
  only appends the usage footer (or finalizes cancelled/failed streams).
  Regens stream into the room's latest reply in place. Stream frames are
  session-private, so this only applies to bridge-originated generations —
  TUI-driven ones arrive whole via `NewMessage`, as before.

## Phase 5 — reactions as controls

- [x] **Reaction handler** in `bot.rs` (`m.reaction` annotations on mapped
  events): 🔁/🔄 = regen (latest reply only), 🗑️/❌ = delete,
  ◀️/⬅️ / ▶️/➡️ = `alt {direction: prev|next}` on that message.

## Phase 6 — thinking / tools / metadata visibility

- [x] **Per-room view prefs** (`!view thinking|tools|usage [on|off|toggle]`),
  persisted as `bridge-view-prefs.json` (`src/prefs.rs`). Mirrors the
  TUI's `:view` toggles.
- [x] **Thinking blocks.** `NewMessage.content_blocks` `Thinking` variants
  render as a collapsed `<details><summary>💭 thinking</summary>` section
  under the reply when enabled (Element renders details; content is
  HTML-escaped).
- [x] **Tool calls.** `ToolCall`/`ToolResult` frames buffered during a
  stream; attached as a collapsed `<details>` checklist when enabled.
  Session-private frames → bridge-originated generations only. (Subagent
  frames are intentionally skipped rather than bracketed.)
- [x] **Usage footer.** `StreamEnd.metadata` (model, tokens, timing) as a
  small `<sub>` footer on streamed replies when `!view usage on`.

## Phase 7 — mirror modes (noise control)

- [x] **`mirror = "replies" | "all" | "off"`** in `[connections.matrix]`,
  default `"replies"`: rooms only receive replies to prompts sent from
  Matrix plus the character's autonomous (heartbeat) messages — other
  clients' conversations stay out. Messages already shown still sync in
  place (edits, alt swaps, regens) via the event map. `"all"` restores the
  full-conversation mirror; `"off"` is the legacy collector path (old
  `mirror_all` boolean still honored when `mirror` is absent).
  Because the daemon's true latest reply can now differ from the room's
  latest shown reply, regen targeting (🔁, regen-in-place, regen stream
  seeding) checks a per-character `last_assistant` msg_id tracked from
  NewMessage broadcasts and history snapshots.

## Known limitations (v1 of this work)

- TUI-side deletes don't redact the Matrix copy — a message disappearing
  from a History snapshot is indistinguishable from compaction, so the
  bridge only drops its mapping. Deletes issued *from Matrix* (redaction,
  🗑️, `!delete`) do redact.
- Cancelling a bridge-initiated regen mid-stream leaves the partially
  streamed text in the (rewritten-in-place) reply until the next mutation.
- Thinking/tools sections are dropped when a message is later edited in
  place (alt swap, TUI edit) — the decoration isn't reconstructed.
- Tool activity and live streaming apply only to generations this bridge
  requested; other clients' generations arrive whole via `NewMessage`.
- In legacy mode (`mirror_all = false`), the event map isn't populated, so
  native edits/redactions/reactions reply with a "not tracked" notice.

## Non-goals (no Matrix equivalent / native already)

- Tab completion, submenu pickers (client capability, not bridgeable).
- Scrollback paging — Matrix rooms have native history. Backfilling
  pre-bridge history would need appservice timestamp massaging; skip.
- Inline image protocol — Matrix renders images natively.

## Deployment note

Installed binary comes from pacman and runs via the `shore-daemon.service`
user unit; after building, deploy deliberately (don't clobber the packaged
binary silently).
