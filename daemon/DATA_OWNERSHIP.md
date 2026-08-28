# Data-directory ownership

Shore supports multiple daemon processes only when each daemon has a different data directory.
Exactly one live daemon may write a canonical data directory at a time. Configuration and client
instance selection do not override this rule.

Before binding its listener or opening runtime stores, a daemon creates
`.shore-daemon-owner.json` in its canonical data directory. A second daemon resolving to the same
directory, including through a relative path or symbolic-link alias, refuses to start and reports
the owning instance and process. A lifetime filesystem lock prevents another process or container
from claiming the directory while that daemon is alive. The operating system releases the lock on
both clean and unclean exits, so a later daemon can reclaim the directory without mistaking a
reused PID for the old daemon. The JSON record retains PID-generation metadata for diagnostics and
for safely migrating records written before the lifetime lock existed. An unverifiable live legacy
owner is never displaced automatically.

To run multiple daemons, give each one a distinct `SHORE_DATA_DIR`. Shore has no writable
secondary or shared-data mode.
