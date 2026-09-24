import { afterEach } from "bun:test";

import { restoreTestEnv } from "./support/env.ts";

process.env["USER"] = "eshen";

afterEach(restoreTestEnv);

import "./support/tmp.ts";
