# Data-directory ownership

Shore supports multiple daemon processes only when each daemon has a different data directory.
Exactly one live daemon may write a canonical data directory at a time. Configuration and client
instance selection do not override this rule.

Before binding its listener or opening runtime stores, a daemon creates
`.shore-daemon-owner.json` in its canonical data directory. A second daemon resolving to the same
directory, including through a relative path or symbolic-link alias, refuses to start and reports
the owning instance and process. A clean shutdown removes the ownership record. After an
unclean exit, a later daemon verifies that the recorded process is dead before reclaiming it; an
unverifiable live owner is never displaced automatically.

To run multiple daemons, give each one a distinct `SHORE_DATA_DIR`. Shore has no writable
secondary or shared-data mode.
