# Conversation history paging

`log` and `history_page` page over the displayed conversation order after tool-loop messages have
been merged. Page bounds are chosen before an optional role filter is applied, matching the command
API's existing behavior.

The numeric `cursor` and `next_before` values are zero-based boundaries in that displayed order.
Passing `next_before` back as `before` requests the page immediately preceding the current one.
Appending active messages does not move an existing boundary. Moving an unchanged prefix from the
active file into archived storage during compaction also preserves it. A history edit or deletion
creates a new ordering, so a client should restart paging from its current snapshot after either
operation.

Archived messages carry indexed display-group metadata in `history.db`. Ordinary pages select only
the requested groups and the raw tool-loop rows belonging to them. Active messages are paged from
the in-memory tail. Legacy databases receive the display metadata and aggregate counts atomically
when first opened by this version.

Each command records whether it used native or fallback paging, archived segments and rows read,
decoded body bytes, and encoded page bytes at debug level. The fallback path is retained only for a
legacy archive that could not be imported into the durable history store.
