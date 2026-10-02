import { describe, expect, test } from "bun:test";

import { truncateChars } from "../src/memory/markdown_query";
import cases from "./memory_captures/markdown_query.json" with { type: "json" };

const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

describe("truncateChars", () => {
  for (const c of cases.truncate_chars) {
    test(c.name, () => {
      expect(truncateChars(b64(c.text), c.limit)).toBe(c.returns);
    });
  }
});
