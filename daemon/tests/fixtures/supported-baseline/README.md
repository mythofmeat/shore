# Oldest supported release

`ada.shore.tar.gz` was produced with `exportCharacter` from commit
`b24a906e` (the repository version at the start of the legacy-removal work),
using synthetic data only. Its SHA-256 is
`bcf5e14b1ceba5c9324b7baf2d4ecd72a221bcf5033a862e75db93c44d448f62`.

The source database contained Ada and Bea. The archive contains Ada's current
configuration, workspace, active conversation, archived segment, captured call,
usage record, SDK session, prompt snapshot, heartbeat, subagent result, and image.
All data was written through that commit's storage APIs. It contains no imported
legacy files. This fixture must remain readable as migration code is removed;
regenerating it with newer code would lose that coverage.
