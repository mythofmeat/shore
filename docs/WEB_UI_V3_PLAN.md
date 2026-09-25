# Web UI v3 — rebuild plan

Status: all eight phases complete as of 2026-09-25 (see "Outcome" at the end). This plan
superseded the CLI-parity approach of issue #214; the old handover and acceptance docs were deleted
and `WEB_GUI.md` now holds operator and developer notes.

Design reference (mockups for every screen below):
https://claude.ai/artifact/Ufj14TjUNNNbk4SzEwe7b9 — the "Conversation" and "Settings, message
states, sign in" rows are the chosen design. "Sodium fog" in the "Style directions" row becomes the
second theme. The other two style boards are reference only.

## Why a rebuild

The v1/v2 UI was built to satisfy source-grepping parity gates that required every CLI command,
flag and choice to reach a browser control. The easiest way to pass was a generic schema-driven
form renderer, which became the primary UI: editing a message showed its UUID, alternatives opened a
"Run action" form, every result ended in raw JSON. Some gates literally required
`JSON.stringify(value, null, 2)` and `Inspect:value=message` to exist in UI files.

The daemon side and the browser data layer are sound and stay. Everything that renders goes.

## Principles

1. **A chat client first.** The main screen serves conversation, and the rest lives in Settings.
2. **Everything reachable, tiered by use.** Every CLI capability gets a home in one of three tiers:
   `inline` (in the chat), `settings` (a settings page), `advanced` (the Advanced section, which
   is allowed to use generated forms). Parity stays enforced, via a ratchet (below).
3. **No flavor text.** Every string is a label, a name, content or a plain explanation.
4. **No raw JSON, message IDs or schema vocabulary** outside Advanced. Results show up as in-place
   updates or a short toast.
5. **Themes change appearance, never structure.** Themes may set design tokens and add scoped CSS,
   but they can't change markup or behavior.
6. **Mock before building** any screen or interaction not already in the design reference.

## Design decisions (from the mockups)

- Dark, flat, Geist (UI and messages) + Geist Mono (model names, tool calls, code). Orange accent
  `#f08a3c` for primary buttons, selection, focus, status, tool success and the swipe counter.
- Sidebar: wordmark, character search, characters with avatars. The selected character expands to
  its conversations plus "New conversation". Settings and connection status sit at the bottom. It
  collapses fully on desktop and becomes a drawer on phones.
- Top bar: character avatar and name, conversation name, model chip (opens model picker),
  conversation menu (rename, fork, archive, compact, context usage, etc.).
- Messages: full-width rows with avatar and name (SillyTavern-style, no bubbles). User rows are
  slightly tinted. Other markers:
  - date dividers
  - an "unprompted" tag on autonomous messages
  - a quiet divider where the active context starts
- Message actions on hover (phones: a row under the message): copy, edit (in place),
  regenerate, branch from here, delete (inline confirm). The last assistant message shows swipe
  arrows `‹ 2 / 3 ›` for alternatives.
- Reasoning: a collapsed "Thought for Ns" chip. Tool calls are one-line chips (`read notes/trip.md ✓`)
  that expand to readable input and output.
- Composer: textarea, attach, send. While a reply is streaming, send becomes Stop. No context
  counter here.
- Settings is a full page with grouped navigation:
  - **Chat:** Models, Characters, Appearance, Keyboard shortcuts
  - **Daemon:** Providers, Usage & budgets, Configuration
  - **Advanced:** Memory & segments, Diagnostics, Traces & call log, Tool runner, Character
    archives, Debug
  - **Disconnect**

## What stays, what goes

**Stays (daemon):** `src/web/*` (server, auth, socket, recovery, archives, request tracking),
SWP transport, typed operation registry, generated protocol types and schemas.

**Stays (browser data layer, framework-free):** `connection.ts`, `operations.ts`, `workspace.ts`,
`drafts.ts`, `wire.ts`, `sync.ts`, `platform.ts`, `media.ts`, `live_limits.ts`, `metadata.ts`,
`text_history.ts`, `clipboard.ts`, `tool_activity.ts`, generated validators. Also `forms.ts` and
`*_forms.ts`, kept for the Advanced section and for the gates' operation-control derivation.
`keyboard.ts`, `preferences*.ts` and `budget_display.ts` stay until phase 5 decides their fate.

**Goes:** every `src/browser/*.tsx`, `app.css`, the 29 Playwright specs in `tests/browser/*.e2e.ts`
(keep `fixtures.ts`, `server.ts`, `navigation.ts` if still useful), UI-coupled parts of
`tests/browser_workspace.test.ts` and `tests/browser_keyboard.test.ts`, and the source-grep adapter
hooks in the coverage scripts.

## Architecture

### Browser source layout

```
src/browser/
  main.tsx                 entry: providers, theme bootstrap, root render
  app/                     shell: SignIn, Shell (sidebar + main), routing between chat/settings
  chat/                    Transcript, Message, MessageActions, Swipe, ToolChip, ThinkingChip,
                           Composer, StreamingMessage, dividers
  sidebar/                 CharacterList, ThreadList, Search, Drawer behavior
  settings/                one module per page; advanced/ reuses forms.ts
  ui/                      Button, IconButton, Menu, Dialog, Toast, Select, Switch, Icon set
  markdown.tsx             mdast (mdast-util-from-markdown, already a dependency) → React elements
  surfaces.ts              declared coverage (see ratchet)
  styles/
    tokens.css             token names + default values
    base.css               reset, typography, focus
    components.css         component styles, tokens only
    themes/default.css     dark/orange
    themes/fog.css         Sodium fog: tokens + scoped extras (grain, fog layers, top fade)
  fonts/                   Geist, Geist Mono, Newsreader woff2 (OFL; self-hosted)
```

State comes from `Workspace` via `useSyncExternalStore`, as today. No new state library.

### Themes

- Components reference only CSS custom properties (`--bg`, `--surface`, `--text-2`, `--accent`,
  `--accent-ink`, `--accent-soft`, `--radius-*`, `--font-ui`, `--font-body`, `--font-mono`, …).
- A theme is `[data-theme="<id>"] { …tokens… }` plus optional rules scoped under the same selector.
- Themes hook onto stable class names and data attributes that components guarantee: `.sidebar`,
  `.topbar`, `.transcript`, `.message[data-role]`, `.composer`, `.chip`, etc.
- The selected theme persists per browser, reusing the existing preferences store, and applies
  before first paint so the page doesn't flash the wrong theme.
- **Lint gate:** raw colors (`#hex`, `rgb(`, `hsl(`) outside `styles/tokens.css` and
  `styles/themes/*` fail `tests/browser_styles.test.ts`.
- Later, optional: a user theme file loaded from the daemon config directory.

### Build and serving

- `scripts/build_browser.ts`: entry `main.tsx`. Concatenate `styles/*.css` + `styles/themes/*.css`
  into one hashed stylesheet. Embed fonts as hashed assets.
- The asset map currently holds string bodies. Add base64 binary bodies for fonts, decoded by the
  server. CSP already allows `font-src 'self'`, and nothing else changes.
- React inline `style` props are set via CSSOM and are compatible with `style-src 'self'`.

## Coverage gates → ratchet

Applies to all four gates: terminal routes, display preferences, local TUI workflows, result
renderers.

- **Blocking, unchanged:** every CLI command/field maps to an existing daemon operation and field.
  That's API parity and independent of the UI.
- **Tier per route:** `TERMINAL_ROUTES` entries gain `tier: "inline" | "settings" | "advanced"`
  (initial guesses, triaged over time).
- **Surfaces:** `src/browser/surfaces.ts` declares what the UI implements:
  `{ "<target>": tier }`, where targets use the existing route vocabulary (`alt.direction`,
  `message.images`, `@editor`, …). A target is covered when declared at a tier at least as
  accessible as its route's tier.
- **Known gaps:** a checked-in list of uncovered units (command paths or `command.field`). The gate
  fails if a unit is uncovered and not listed, or if it's listed but now covered (stale entries
  must be deleted). The list only shrinks.
- **Not applicable:** a list with a reason per entry for terminal-only concepts, e.g. shell
  completions, TCP address and discovery, `--help`, `--version`, `--json`.
- **Removed:** source-grep adapter hooks and the "generated action path must exist in app.tsx"
  check.
- Surface declarations are claims. The Playwright journeys for each phase are what back them up.

## Phases

Each phase ends with the full check suite (now `.githooks/pre-commit`) green, then a commit.
Playwright journeys land with the feature they cover, not at the end.

1. **Teardown + ratchet (one commit).**
   - Delete the UI files listed above.
   - Add a minimal `main.tsx` that signs in and renders a placeholder shell.
   - Convert the four gates, with known gaps seeded by the new UI's coverage (nearly everything).
   - Mark `WEB_GUI_HANDOVER.md` and `WEB_GUI_ACCEPTANCE.md` for deletion, and trim `WEB_GUI.md`
     to operator docs (LAN/Tailscale/SSH access, config).
2. **Foundation.**
   - Styles and tokens, the default theme, embedded fonts, the CSS color lint.
   - `ui/` primitives.
   - The shell: sidebar with desktop collapse and phone drawer, top bar, sign-in, connection status
     and reconnect.
3. **Core chat.**
   - Transcript: Markdown, dividers, thinking and tool chips, images, unprompted tag, context
     boundary, autoscroll, load earlier.
   - Composer: drafts via `drafts.ts`, attachments and paste, send, stop.
   - Streaming.
   - Message actions: copy, inline edit, inline delete confirm, regenerate, swipes
     (`list_alternatives`/`alt`), branch (`fork_thread`).
4. **Navigation.**
   - Characters: avatars, search, create.
   - Threads: create, rename, archive, fork, home.
   - Model chip → model picker; conversation menu.
5. **Settings.**
   - Pages: Models, Characters, Appearance (theme picker), Providers, Usage & budgets,
     Configuration.
   - Decide whether Keyboard shortcuts keeps the configurable-bindings system or starts simpler.
6. **Sodium fog theme.** Port it as the second theme and check that it needs no component changes.
   Any change it needs is a missing hook to fix in the components.
7. **Advanced.**
   - Generic forms with readable result views.
   - Work through known gaps: promote what deserves a designed UI, leave the rest in Advanced.
8. **Cleanup.**
   - Delete the superseded docs and any browser modules that ended up unused.
   - Final pass on phone layouts.

## Decisions on the open questions

- **Keyboard shortcuts:** a fixed, documented set (Settings → Keyboard shortcuts, `?` from
  anywhere) plus a command palette on Ctrl/⌘+K. Rebinding is not offered yet; `local:bind` and
  `local:unbind` are the only remaining known gaps. `keyboard.ts` keeps the tested binding model
  for when rebinding is built.
- **Light theme:** not planned. The token system supports it if it's ever wanted.
- **Context usage:** shown in Settings → Diagnostics (context tokens, messages, turns), not in the
  chat. Budgets can optionally appear as a small chip in the top bar (off by default).
- **User-supplied theme file:** not built; still possible later on top of the theme tokens.

## Outcome

- Phases 1–8 are done. The Sodium fog theme landed together with phases 2–3.
- Deviation: the mockup's per-message "Branch from here" was dropped. The daemon forks the last N
  turns of a conversation, not up to an arbitrary message, so forking lives in the conversation
  menu as "Fork conversation…" with an optional turn count.
- Parity: 254 known gaps at the start of phase 1, 2 at the end (`local:bind`, `local:unbind`).
  Terminal-only concepts are listed with reasons in `scripts/browser_parity.ts`.
- Verification: `tests/browser_parity.test.ts`, `tests/browser_chat.test.ts`,
  `tests/browser_settings.test.ts`, `tests/browser_styles.test.ts`, the Playwright journeys in
  `tests/browser/`, and the `browser_chat` mutation pass (30/30 mutants killed).
