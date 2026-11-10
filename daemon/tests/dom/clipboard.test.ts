import { afterEach, describe, expect, test } from "bun:test";

import { useDom } from "./dom.ts";

useDom();

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  document.body.replaceChildren();
});

function replace<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => { if (original === undefined) Reflect.deleteProperty(target, key); else Object.defineProperty(target, key, original); });
}

describe("copying text", () => {
  test("uses the clipboard when the page has one", async () => {
    const written: string[] = [];
    replace(navigator, "clipboard", { writeText: async (text: string) => { await Promise.resolve(); written.push(text); } });
    const { copyText } = await import("../../src/browser/clipboard.ts");
    await copyText("hello");
    expect(written).toEqual(["hello"]);
    expect(document.querySelector("textarea")).toBeNull();
  });

  test("without a clipboard copies from a hidden box it removes again, and puts the focus back", async () => {
    replace(navigator, "clipboard", undefined);
    const copied: string[] = [];
    replace(document, "execCommand", (command: string) => {
      const box = document.querySelector("textarea");
      copied.push(`${command}:${box?.value ?? ""}:${box?.className ?? ""}:${String(box?.selectionStart)}-${String(box?.selectionEnd)}`);
      box?.focus();
      return true;
    });
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const { copyText } = await import("../../src/browser/clipboard.ts");
    await copyText("hello");
    expect(copied, "the whole text is selected").toEqual(["copy:hello:sr-only:0-5"]);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  test("says how to copy by hand when the browser refuses, and still cleans up", async () => {
    replace(navigator, "clipboard", undefined);
    replace(document, "execCommand", () => false);
    const { copyText } = await import("../../src/browser/clipboard.ts");
    expect(await copyText("hello").then(() => "", (error: unknown) => (error as Error).message)).toBe("Copy is unavailable in this browser. Select the message text to copy it.");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
