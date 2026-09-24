import { afterEach } from "bun:test";

import { restoreTestEnv } from "./support/env.ts";
import { testRunRoot } from "./support/tmp.ts";

process.env["USER"] = "peggy";
process.env["TMPDIR"] = testRunRoot();

afterEach(restoreTestEnv);
