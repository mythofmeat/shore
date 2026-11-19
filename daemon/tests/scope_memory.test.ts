import { expect, test } from "bun:test";

import { unreclaimable } from "../scripts/scope_memory.ts";

test("a test run's memory leaves out the page cache the kernel can take back, and keeps files written to a tmpfs", () => {
  const stat = [
    "anon 104857600",
    "file 398458880",
    "shmem 199229440",
    "inactive_anon 200278016",
    "active_anon 0",
    "inactive_file 199229440",
    "active_file 1048576",
    "",
  ].join("\n");
  expect(unreclaimable(503316480, stat)).toBe(303038464);
});
