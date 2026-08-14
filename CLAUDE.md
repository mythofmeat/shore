# Rules for Claude

## Do not write comments

No comments in code you write. Not headers, not section banners, not JSDoc, not
a trailing note on a tricky line. If you are about to explain code, rename
something or split a function instead.

This is enforced everywhere. `daemon/scripts/check_no_comments.ts` fails CI on
any comment in `daemon/src`, `daemon/tests`, `daemon/scripts` and `client/`. Run
it with `bun run lint:comments` from `daemon/`.

Three narrow exceptions, all machine-read rather than human-read:

- Compiler and linter directives: `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`,
  `eslint-*`, `biome-ignore`, `prettier-ignore`, `<reference ...>`, and in Rust
  `// SAFETY:` on an `unsafe` block, which is a soundness obligation the
  compiler cannot check for you.
- Generated files, which their generator owns. `daemon/src/protocol/*.ts` is
  ts-rs output; do not hand-edit it, and do not strip its header. If a comment
  there is wrong, fix the Rust doc comment it came from.
- Clap help text. In `client/shore-cli/src/cli.rs` and
  `client/shore-tui/src/main.rs` a `///` on a command, flag or variant *is* the
  string printed by `--help`. It is user interface that happens to use comment
  syntax. Nowhere else in `client/` may carry a doc comment.

## Why

`daemon/src` was 36% comment by line and the comments were wrong. They described
the deleted Rust daemon in the present tense: two files claimed a coupling with
`crates/daemon/src/llm/types.rs` that had not existed for weeks, one said nothing
called it while another module imported it, one explained a security check in
terms of Rust path semantics no longer in the codebase. 19,524 lines were deleted
in `9150dff8` and no test changed.

Prose is not checkable, so nothing caught any of it. A reader who trusts a
comment over the code is misled precisely where the comment sounds most
confident. That includes you.

The claims worth keeping were already tests. When the invariants those comments
asserted were checked, 1,006 of 1,037 sat in modules the suite already covered —
usually asserted more precisely than the prose managed.

## Instead of a comment

- Name the thing. `reprimeFromDisk` beats `// re-arm the keepalive from disk`.
- Write the test. An executable claim cannot rot silently.
- Put history in the commit message. `git log -S` finds it; a stale header does
  not.
- Put design in the issue. That is what the tracker is for.

## The fixtures

`daemon/tests/**/*.json` holds recorded cases from the deleted Rust. Keep the
cases; their inputs are hard to re-derive. Do not give them a prose header.

They used to have one. Sixty-four fixtures carried about 9,600 words asserting
provenance and freezing policy, on the theory that the deleted Rust was the
specification and a header was what made a 50k-line blob auditable. It was not.
Two of those headers came to contradict each other, and the disagreement cost a
whole session and still had to be settled by asking. A recorded case is
auditable because a test replays it and fails, not because a paragraph above it
claims authority.

So: when a recorded case disagrees with what shore should do, correct the case
and say why in the commit. Do not stop to ask which header wins. Where a fixture
came from belongs in the commit that added it.
