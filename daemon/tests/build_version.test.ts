import { describe, expect, test } from "bun:test";

import { normalizeBuildVersion, resolveBuildVersion } from "../src/build_version.ts";

describe("build versions", () => {
  test("git describe is normalized exactly like the Rust client version", () => {
    expect(normalizeBuildVersion("v4.10.18-0-g4cc0ece\n")).toBe("4.10.18.r0.g4cc0ece");
    expect(normalizeBuildVersion("v4.11.0-rc.1-3-g1234567")).toBe(
      "4.11.0.rc.1.r3.g1234567",
    );
  });

  test("an explicit stamp wins without needing a Git checkout", () => {
    expect(resolveBuildVersion({ SHORE_BUILD_VERSION: "release-build" }, "/does/not/exist")).toBe(
      "release-build",
    );
  });
});
