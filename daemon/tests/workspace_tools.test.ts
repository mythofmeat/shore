import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { characterGitIdentity } from "../src/tools/workspace";

const fixture = JSON.parse(
  readFileSync(new URL("./tools_captures/workspace_tools.json", import.meta.url), "utf8"),
) as Fixture;

interface Fixture {
  git_identity: { character: string; name: string; email: string }[];
}

describe("git identity", () => {
  for (const c of fixture.git_identity) {
    test(`identity: ${JSON.stringify(c.character)}`, () => {
      expect(characterGitIdentity(c.character)).toEqual([c.name, c.email]);
    });
  }
});
