// The frozen parity fixtures were generated on a machine where `$USER` was
// `eshen`, and `resolveDisplayName` falls back to it. Pinning it here is what
// makes the suite hermetic: without it, the assembled prompt says "User" (or
// the builder's account name) and every fixture carrying a display name fails.
process.env["USER"] = "eshen";

import "./support/tmp.ts";
