Apply a contextual patch using the native OpenAI Codex patch engine. Paths are absolute or relative to the workspace, with the same host access as bash. This is the Codex patch format, not a unified diff:

*** Begin Patch
*** Add File: hello.txt
+Hello
*** Update File: existing.txt
@@
 unchanged context
-old text
+new text
*** Delete File: obsolete.txt
*** End Patch

Use *** Move to: destination immediately after an Update File header to rename while editing. Hunk lines begin with space (context), - (remove), or + (insert). @@ may include a context anchor; *** End of File anchors a hunk at EOF. The engine checks context, with Codex's whitespace matching fallbacks. Empty or malformed patches and unmatched context return errors. Changes are applied sequentially: a later failure or cancellation can leave earlier changes in place. The error result does not imply rollback.
