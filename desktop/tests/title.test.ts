import { expect, test } from "bun:test";
import { unreadCount } from "../src/title.ts";

test("unreadCount reads the count the browser client puts in front of its title", () => {
  expect(unreadCount("(3) Yuna · Shore")).toBe(3);
  expect(unreadCount("(12) Settings · Shore")).toBe(12);
  expect(unreadCount("Yuna · Shore")).toBe(0);
  expect(unreadCount("Shore (3)")).toBe(0);
  expect(unreadCount("(three) Shore")).toBe(0);
});
