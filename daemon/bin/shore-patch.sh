#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: shore-patch [--check] < patch.diff

Apply a standard unified diff to files relative to the current directory.
Start each file with a 'diff --git a/path b/path' header, including in multi-file
patches. Use a/ and b/ path prefixes. For additions, include 'new file mode 100644'
after that header and use /dev/null as the old path. For deletions, include
'deleted file mode 100644' and use /dev/null as the new path (100755 for executables).
This is not Codex's Begin Patch format.
Include unchanged context around edits; hunk line counts are recalculated.
If any hunk fails validation, no files are changed. --check only validates.
This command never stages files, creates commits, or pushes. No Git repo is needed.

Example (the file must contain these three lines):
shore-patch <<'PATCH'
diff --git a/notes.md b/notes.md
--- a/notes.md
+++ b/notes.md
@@ -1,3 +1,3 @@
 before
-old wording
+new wording
 after
PATCH

Read the files before editing. Check the exit status and inspect the result.
HELP
}

if [[ $# -eq 1 && $1 == --help ]]; then
  usage
  exit 0
fi

options=()
if [[ $# -eq 1 && $1 == --check ]]; then
  options+=(--check)
elif [[ $# -ne 0 ]]; then
  printf '%s\n' 'Usage: shore-patch [--check] < patch.diff (see shore-patch --help)' >&2
  exit 2
fi

git --git-dir=/dev/null -c apply.ignoreWhitespace=no apply \
  --no-index --recount --whitespace=nowarn --verbose "${options[@]}" -

if [[ ${#options[@]} -eq 0 ]]; then
  printf '%s\n' 'Patch applied.'
else
  printf '%s\n' 'Patch checks passed; no files changed.'
fi
