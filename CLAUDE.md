# Rules for Claude

## Do not write comments

No comments in code you write. Not headers, not section banners, not JSDoc, not
a trailing note on a tricky line. If you are about to explain code, rename
something or split a function instead.

This is enforced. `daemon/scripts/check_no_comments.ts` fails CI on any comment
in `daemon/src`. Run it with `bun run lint:comments` from `daemon/`.

Two narrow exceptions, both machine-read rather than human-read:

- Compiler and linter directives: `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`,
  `eslint-*`, `biome-ignore`, `prettier-ignore`, `<reference ...>`.
- Generated files, which their generator owns. `daemon/src/protocol/*.ts` is
  ts-rs output; do not hand-edit it, and do not strip its header. If a comment
  there is wrong, fix the Rust doc comment it came from.

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

## Existing comments

`daemon/tests` keeps its comments. In a frozen parity fixture the deleted Rust
*is* the specification, so `"Generated from crates/... at 9023b46d. FROZEN."` is
what makes a 50k-line blob auditable. Do not add new ones there.

`client/` (Rust) is unswept. Do not add comments; do not bulk-remove them either
without being asked.
