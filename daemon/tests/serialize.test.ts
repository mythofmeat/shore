import { describe, expect, test } from "bun:test";

import { REDACTED, redactSecrets } from "../src/config/serialize.ts";

describe("redacting secrets from a config dump", () => {
  test("a secret of any kind is hidden wherever it sits unless it is empty or unset, and everything else is kept", () => {
    expect(redactSecrets({
      notifications: { topic: "private-topic", ntfy: { topic: "" } },
      mcp: { search: { env: { KEY: "abc", PORT: 8080, LIST: ["a"], NONE: null }, headers: { Authorization: { bearer: "x" } }, command: "search" } },
      chat: { model: "anthropic:claude" },
    })).toEqual({
      notifications: { topic: REDACTED, ntfy: { topic: "" } },
      mcp: { search: { env: { KEY: REDACTED, PORT: REDACTED, LIST: REDACTED, NONE: null }, headers: { Authorization: REDACTED }, command: "search" } },
      chat: { model: "anthropic:claude" },
    });
    expect(redactSecrets(undefined, ["mcp", "search", "env", "KEY"])).toBeUndefined();
    expect(redactSecrets([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
});
