import { expect, test } from "bun:test";
import { TextHistory, textSnapshot } from "../src/browser/text_history.ts";

test("typing groups stop at whitespace, selection changes and editor handoff", () => {
  const history = new TextHistory();
  for (const text of ["h", "he", "hey", "hey ", "hey y", "hey yo"]) history.change(textSnapshot(text), "insertText");
  expect(history.step("undo")?.text).toBe("hey ");
  expect(history.step("undo")?.text).toBe("");
  expect(history.step("redo")?.text).toBe("hey ");
  history.select(0, 3, "backward");
  history.change(textSnapshot("hi ", 2), "insertText");
  expect(history.canRedo).toBe(false);
  expect(history.step("undo")).toEqual(textSnapshot("hey ", 0, 3, "backward"));
  history.change(textSnapshot("editor"), "insertText");
  history.breakGroup();
  history.change(textSnapshot("editor handoff"), "insertText");
  expect(history.step("undo")?.text).toBe("editor");
});

test("successful send and programmatic restore remain undoable with Unicode selection intact", () => {
  const history = new TextHistory();
  history.reset("🌊 café\nsecond line");
  history.select(3, 7, "backward");
  history.change(textSnapshot(""));
  expect(history.step("undo")).toEqual(textSnapshot("🌊 café\nsecond line", 3, 7, "backward"));
  expect(history.step("redo")?.text).toBe("");
  history.change(textSnapshot("Recovered saved draft"));
  expect(history.step("undo")?.text).toBe("");
  history.reset("Another conversation");
  expect(history.canUndo).toBe(false);
  expect(history.canRedo).toBe(false);
  expect(history.step("undo")).toBeUndefined();
  expect(history.step("redo")).toBeUndefined();
});

test("composition commits one undo step despite intermediate text and selection changes", () => {
  const history = new TextHistory();
  history.reset("Draft ");
  history.beginComposition();
  history.change(textSnapshot("Draft n"), "insertCompositionText");
  history.select(6, 7, "forward");
  history.change(textSnapshot("Draft ni"), "insertCompositionText");
  history.select(6, 8, "forward");
  history.change(textSnapshot("Draft 你"), "insertCompositionText");
  history.endComposition();
  expect(history.step("undo")?.text).toBe("Draft ");
  expect(history.step("redo")?.text).toBe("Draft 你");
  history.change(textSnapshot("Draft 你好"), "insertText");
  expect(history.step("undo")?.text).toBe("Draft 你");
});

test("history has count and byte bounds without truncating the current text", () => {
  const history = new TextHistory();
  for (let index = 0; index < 205; index++) history.change(textSnapshot(String(index)));
  const values = [];
  while (history.canUndo) values.push(history.step("undo")?.text);
  expect(values).toHaveLength(200);
  expect(values.at(-1)).toBe("4");
  history.reset("");
  const large = "a".repeat(3 * 1024 * 1024);
  history.change(textSnapshot(large));
  history.change(textSnapshot(large + "b"));
  history.change(textSnapshot("current"));
  expect(history.step("undo")?.text).toBe(large + "b");
  expect(history.canUndo).toBe(false);
  expect(history.step("redo")?.text).toBe("current");
  expect(textSnapshot("🌊", -1, 100)).toEqual({ text: "🌊", start: 0, end: 2, direction: "none" });
});
