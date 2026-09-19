import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderConfigReference } from "../src/config/reference.ts";

const path = join(import.meta.dir, "../../docs/CONFIG_REFERENCE.md");
const rendered = renderConfigReference();
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== rendered) throw new Error("configuration reference is stale; run bun run config:reference");
} else writeFileSync(path, rendered);
