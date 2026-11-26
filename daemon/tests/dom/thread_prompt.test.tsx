import { expect, test } from "bun:test";

import type { ThreadPromptView } from "../../src/protocol/ThreadPromptView.ts";
import type { ThreadView } from "../../src/protocol/ThreadView.ts";
import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };

const HOME: ThreadView = { id: "story", created_at: "2026-11-01T00:00:00Z", compaction: true, home: true, current: true };
const SIDE: ThreadView = { id: "side", label: "The lighthouse", purpose: "A story.", pins: ["notes/plan.md"], created_at: "2026-11-02T00:00:00Z", compaction: false, home: false, current: false };
const WAKES: ThreadView = { id: "wakes", created_at: "2026-11-03T00:00:00Z", compaction: false, home: false, current: false, wakes: true };

const VIEW: ThreadPromptView = {
  thread: "side",
  parts: [
    { label: "SOUL.md", text: "Ada keeps the lighthouse.", changed: true },
    { label: "thread", text: "This is the side thread \"side\".", changed: false },
    { label: "thread_pins", text: "Pinned here.\n\n## notes/plan.md\n\nChapter three.", changed: false },
  ],
  pins: [
    { pin: "notes/plan.md", bytes: 14, shown: "whole", changed: false },
    { pin: "notes/edited.md", bytes: 1023, shown: "whole", changed: true },
    { pin: "stories/long.md", bytes: 33_280, shown: "cut", changed: false },
    { pin: "stories/longer.md", bytes: 1024, shown: "left_out", changed: false },
    { pin: "notes/gone.md", bytes: 0, shown: "nothing", changed: false },
    { pin: "!git log --oneline -5", bytes: 0, shown: "nothing", changed: false },
  ],
};

const asked = (since: number, name: string) => app.sent(since).filter((request) => request["name"] === name).map((request) => request["args"]);
const field = (root: ParentNode, label: string) => [...root.querySelectorAll("label.field")].find((item) => item.querySelector("span")?.textContent?.startsWith(label))?.querySelector("input, textarea, select");
const dialog = (title: string) => [...document.body.querySelectorAll("dialog")].find((item) => item.querySelector("h2")?.textContent === title);
const rows = (root: ParentNode | undefined) => [...(root?.querySelectorAll(".pin-status-row") ?? [])].map((row) => [row.querySelector(".pin-path")?.textContent, row.querySelector(".pin-state")?.textContent, row.querySelector(".pin-state")?.className]);

async function quiet(): Promise<void> {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  await acting(() => { for (const shown of toasts.getSnapshot()) toasts.dismiss(shown.id); });
}

async function shownToasts(): Promise<string[]> {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  return toasts.getSnapshot().map((shown) => shown.text);
}

async function settings(thread: ThreadView, threads: ThreadView[] = [HOME, SIDE, WAKES]) {
  const { ThreadDialogs } = await import("../../src/browser/chat/thread_dialogs.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const state = { ...chromeOf(undefined, app.state().workspace.getSnapshot()), status: "ready" as const, character: "ada", threads };
  const view = await mount(<ThreadDialogs state={state} request={{ kind: "settings", thread: thread.id }} close={() => {}} />);
  await settle();
  return view;
}

test("a thread's settings show each saved pin as its next message sends it: its size, or that it is cut, left out, missing, not run yet or changed since", async () => {
  app.answer((request) => request["name"] === "thread_prompt" ? VIEW : undefined);
  const since = app.socket().sent.length;
  const view = await settings(SIDE);

  expect(asked(since, "thread_prompt")).toEqual([{ name: "side" }]);
  expect([...document.body.querySelectorAll("dialog")].map((item) => item.querySelector("h2")?.textContent)).toEqual(["Thread settings"]);
  const saved = document.body.querySelector("[aria-label='Saved pins']");
  expect(saved?.closest(".field")?.querySelector("span")?.textContent).toBe("Saved pins, as the next message sends them");
  expect(rows(saved ?? undefined)).toEqual([
    ["notes/plan.md", "14 B", "pin-state "],
    ["notes/edited.md", "1023 B · changed since; the model sees it after a refresh", "pin-state warn"],
    ["stories/long.md", "32.5 KB · cut: past what a thread’s pins can take together", "pin-state warn"],
    ["stories/longer.md", "1 KB · left out: past what a thread’s pins can take together", "pin-state danger"],
    ["notes/gone.md", "empty, or not in the workspace", "pin-state danger"],
    ["!git log --oneline -5", "runs with the next message", "pin-state quiet"],
  ]);
  expect(field(document.body, "Purpose")).toBeDefined();
  expect(document.body.querySelector(".pin-actions + p.form-hint, .form-hint")?.textContent).toBeDefined();
  expect([...document.body.querySelectorAll("p.form-hint")].map((hint) => hint.textContent)).toContain("The character sees the purpose and these pins in this thread’s prompt. One per line: a workspace path or [[link]], or a shell command after a ! whose output is shown instead.");
  await view.unmount();
});

test("a thread's settings say while the saved pins are being checked and why they couldn't be, list none when there are none, and View prompt waits for them", async () => {
  app.answer((request) => request["name"] === "thread_prompt" ? HOLD : undefined);
  const waiting = await settings(SIDE);
  const hints = () => [...document.body.querySelectorAll("p.form-hint")].map((hint) => hint.textContent);
  expect(hints()).toContain("Checking the saved pins…");
  expect(button(document.body, "View prompt…").disabled).toBe(true);
  await waiting.unmount();

  app.answer((request) => { if (request["name"] === "thread_prompt") throw new Error("no model is set up"); return undefined; });
  const failed = await settings(SIDE);
  expect(hints()).toContain("The saved pins couldn’t be checked: no model is set up");
  expect(button(document.body, "View prompt…").disabled).toBe(true);
  await failed.unmount();

  app.answer((request) => request["name"] === "thread_prompt" ? { ...VIEW, pins: [] } : undefined);
  const bare = await settings(SIDE);
  expect([document.body.querySelector("[aria-label='Saved pins']"), hints().some((hint) => (hint ?? "").startsWith("Checking") || (hint ?? "").startsWith("The saved pins"))]).toEqual([null, false]);
  expect(button(document.body, "View prompt…").disabled).toBe(false);
  await bare.unmount();
});

test("the home thread's settings have pins but no purpose, and the Wakes thread's have neither and ask for no prompt", async () => {
  app.answer((request) => request["name"] === "thread_prompt" ? { ...VIEW, thread: "story" } : undefined);
  const home = await settings(HOME);
  expect([field(document.body, "Purpose"), field(document.body, "Pinned in the prompt")?.tagName]).toEqual([undefined, "TEXTAREA"]);
  expect([...document.body.querySelectorAll("p.form-hint")].map((hint) => hint.textContent)).toContain("The character sees these pins in this thread’s prompt. One per line: a workspace path or [[link]], or a shell command after a ! whose output is shown instead.");
  await home.unmount();

  const since = app.socket().sent.length;
  const wakes = await settings(WAKES);
  expect([field(document.body, "Purpose"), field(document.body, "Pinned in the prompt"), document.body.querySelector(".pin-actions"), document.body.querySelector("[aria-label='Saved pins']")]).toEqual([undefined, undefined, null, null]);
  expect(asked(since, "thread_prompt")).toEqual([]);
  await wakes.unmount();
});

test("saving changed pins says what was pinned, as the daemon stored it, and saving anything else says nothing", async () => {
  const { pins: _saved, ...bare } = SIDE;
  const stored = (pins: string[] | undefined) => ({ character: "ada", threads: [HOME, pins === undefined ? bare : { ...bare, pins }], home: "story", current: "story" });
  let pinned: string[] | undefined = ["notes/plan.md"];
  app.answer((request) => {
    if (request["name"] === "thread_prompt") return VIEW;
    if (request["name"] === "thread_pins") return stored(pinned);
    if (String(request["name"]).startsWith("thread_") || request["name"] === "list_threads") return stored(SIDE.pins);
    return undefined;
  });
  const save = async (pins: string | undefined, label?: string) => {
    const view = await settings(SIDE);
    if (pins !== undefined) await type(field(document.body, "Pinned in the prompt"), pins);
    if (label !== undefined) await type(field(document.body, "Label"), label);
    await quiet();
    await click(button(document.body, "Save"));
    await settle();
    const said = await shownToasts();
    await quiet();
    await view.unmount();
    return said;
  };

  pinned = ["notes/plan.md", "notes/lamp.md", "!date", "notes/four.md"];
  expect(await save("notes/plan.md\n[[lamp]]\n!date\nnotes/four.md")).toEqual(["Pinned notes/plan.md, notes/lamp.md, !date and 1 more"]);
  pinned = ["notes/plan.md", "notes/lamp.md", "!date"];
  expect(await save("notes/plan.md\n[[lamp]]\n!date")).toEqual(["Pinned notes/plan.md, notes/lamp.md, !date"]);
  pinned = undefined;
  expect(await save("")).toEqual(["Pins cleared"]);
  expect(await save(undefined, "Renamed")).toEqual([]);
  app.answer((request) => {
    if (request["name"] === "thread_prompt") return VIEW;
    if (request["name"] === "thread_pins") return { character: "ada", threads: [HOME], home: "story", current: "story" };
    if (String(request["name"]).startsWith("thread_") || request["name"] === "list_threads") return stored(SIDE.pins);
    return undefined;
  });
  expect(await save("notes/other.md")).toEqual([]);
});

test("Add a file lists the workspace's files to search, marks the ones already pinned, and adds the one picked to the list", async () => {
  const files = ["SOUL.md", "notes/plan.md", "notes/Lamp.md", ...Array.from({ length: 100 }, (_, at) => `days/day-${String(at).padStart(3, "0")}.md`)];
  app.answer((request) => {
    if (request["name"] === "thread_prompt") return VIEW;
    if (request["name"] === "workspace_files") return { files };
    return undefined;
  });
  const view = await settings(SIDE);
  await click(button(document.body, "Add a file…"));
  await settle();
  const picker = dialog("Pin a file");
  const options = () => [...(picker?.querySelectorAll("[role=option]") ?? [])].map((option) => [option.textContent, option.getAttribute("aria-selected"), (option as HTMLButtonElement).disabled]);
  const more = () => picker?.querySelector("p.picker-empty")?.textContent;
  expect(options()).toHaveLength(100);
  expect(options().slice(0, 3)).toEqual([["SOUL.md", "false", false], ["notes/plan.md", "true", true], ["notes/Lamp.md", "false", false]]);
  expect(more()).toBe("3 more; type to narrow the list.");
  const ticked = [...(picker?.querySelectorAll("[role=option]") ?? [])].map((option) => option.querySelector("svg.picker-check")?.getAttribute("width") ?? null);
  expect([picker?.querySelector(".picker-search svg")?.getAttribute("width"), ticked.slice(0, 3), ticked.filter((width) => width !== null)]).toEqual(["16", [null, "16", null], ["16"]]);
  await type(picker?.querySelector("input[type=search]"), "days/");
  expect([options().length, more()]).toEqual([100, undefined]);
  expect(picker?.querySelector(".form-text")?.textContent).toBe("Hidden files, pictures and videos aren’t listed. Any path, [[link]] or !command can still be typed into the list.");

  await type(picker?.querySelector("input[type=search]"), " LAMP ");
  expect([options(), more()]).toEqual([[["notes/Lamp.md", "false", false]], undefined]);
  await type(picker?.querySelector("input[type=search]"), "nowhere");
  expect([options(), more()]).toEqual([[], "No files match."]);
  await type(picker?.querySelector("input[type=search]"), "lamp");
  const box = field(document.body, "Pinned in the prompt") as HTMLTextAreaElement;
  expect(document.activeElement === box).toBe(false);
  await click(picker?.querySelector("[role=option]"));
  expect([dialog("Pin a file"), box.value]).toEqual([undefined, "notes/plan.md\nnotes/Lamp.md"]);
  expect([document.activeElement === box, box.selectionStart, box.selectionEnd]).toEqual([true, box.value.length, box.value.length]);
  await view.unmount();
});

test("Add a file says why the workspace's files couldn't be listed, and shows them loading until they are", async () => {
  app.answer((request) => {
    if (request["name"] === "thread_prompt") return VIEW;
    if (request["name"] === "workspace_files") throw new Error("the workspace helper is down");
    return undefined;
  });
  const failed = await settings(SIDE);
  await click(button(document.body, "Add a file…"));
  await settle();
  expect([dialog("Pin a file")?.querySelector("[role=alert]")?.textContent, dialog("Pin a file")?.querySelector(".spinner")]).toEqual(["the workspace helper is down", null]);
  await failed.unmount();

  app.answer((request) => {
    if (request["name"] === "thread_prompt") return VIEW;
    if (request["name"] === "workspace_files") return HOLD;
    return undefined;
  });
  const waiting = await settings(SIDE);
  await click(button(document.body, "Add a file…"));
  await settle();
  expect([dialog("Pin a file")?.querySelector("[role=alert]"), dialog("Pin a file")?.querySelector(".spinner")?.getAttribute("aria-label")]).toEqual([null, "Loading files"]);
  await click(button(dialog("Pin a file") ?? document.body, "Close"));
  expect(dialog("Pin a file")).toBeUndefined();
  await waiting.unmount();
});

test("a new thread can be given a picked file as a pin", async () => {
  app.answer((request) => {
    if (request["name"] === "workspace_files") return { files: ["notes/plan.md", "notes/lamp.md"] };
    if (request["name"] === "create_thread") return { character: "ada", threads: [HOME], home: "story", current: "story" };
    if (request["name"] === "switch_thread") return { character: "ada", thread: "lamp", changed: true };
    return undefined;
  });
  const { NewThreadDialog } = await import("../../src/browser/sidebar/dialogs.tsx");
  const view = await mount(<NewThreadDialog character="ada" close={() => {}} />);
  const since = app.socket().sent.length;
  await type(field(view.host, "Name"), "lamp");
  expect(field(view.host, "Pinned in the prompt")?.closest("label")?.querySelector(".muted")?.textContent).toBe("(optional, one per line)");
  await type(field(view.host, "Pinned in the prompt"), "notes/plan.md\n");
  await click(button(view.host, "Add a file…"));
  await settle();
  await click([...(dialog("Pin a file")?.querySelectorAll("[role=option]") ?? [])].find((option) => option.textContent === "notes/lamp.md"));
  await click(view.host.querySelector("button[type=submit]"));
  await settle();
  expect(asked(since, "create_thread")).toEqual([{ name: "lamp", pins: ["notes/plan.md", "notes/lamp.md"] }]);
  await view.unmount();
});

test("View prompt shows each part of the thread's system prompt with its size, opens the thread's own parts, and marks a part changed since", async () => {
  app.answer((request) => request["name"] === "thread_prompt" ? VIEW : undefined);
  const view = await settings(SIDE);
  await click(button(document.body, "View prompt…"));
  const shown = dialog("Prompt for “The lighthouse”");
  const parts = [...(shown?.querySelectorAll("details.prompt-part") ?? [])].map((part) => [part.querySelector("summary")?.textContent, part.hasAttribute("open"), part.querySelector("pre")?.textContent]);
  expect(parts).toEqual([
    ["SOUL.md 25 Bchanged since; the model sees it after a refresh", false, "Ada keeps the lighthouse."],
    ["thread 31 B", true, "This is the side thread \"side\"."],
    ["thread_pins 46 B", true, "Pinned here.\n\n## notes/plan.md\n\nChapter three."],
  ]);
  expect(rows(shown?.querySelector("[aria-label='Saved pins']") ?? undefined)).toHaveLength(6);
  expect(shown?.querySelector(".prompt-refresh .form-hint")?.textContent).toBe("The prompt refreshes on its own after a long pause here, and when this thread compacts. Refreshing now reads the pinned files and runs the pinned commands again, and the next message misses the prompt cache.");
  await click(button(shown ?? document.body, "Close"));
  expect(dialog("Prompt for “The lighthouse”")).toBeUndefined();
  await view.unmount();

  app.answer((request) => request["name"] === "thread_prompt" ? { thread: "story", parts: [], pins: [] } : undefined);
  const home = await settings(HOME);
  await click(button(document.body, "View prompt…"));
  const empty = dialog("Prompt for “story”");
  expect([empty?.querySelector(".dialog-body > .form-text:last-of-type")?.textContent, empty?.querySelector("[aria-label='Saved pins']")]).toEqual(["This thread has no system prompt.", null]);
  expect(empty?.querySelector(".prompt-refresh .form-hint")?.textContent).toStartWith("The prompt refreshes on its own when this thread compacts.");
  await home.unmount();
});

test("Refresh now refreshes the thread's prompt and shows it again, says why it couldn't, and waits while the thread is replying", async () => {
  const fresh: ThreadPromptView = { ...VIEW, parts: [{ label: "SOUL.md", text: "Ada sails.", changed: false }], pins: [] };
  let refreshed = false;
  app.answer((request) => {
    if (request["name"] === "thread_prompt_refresh") { refreshed = true; return fresh; }
    if (request["name"] === "thread_prompt") return refreshed ? fresh : VIEW;
    return undefined;
  });
  const view = await settings(SIDE);
  await click(button(document.body, "View prompt…"));
  const since = app.socket().sent.length;
  await click(button(dialog("Prompt for “The lighthouse”") ?? document.body, "Refresh now"));
  await settle();
  expect(app.sent(since).filter((request) => request["type"] === "command").map((request) => [request["name"], request["args"]])).toEqual([["thread_prompt_refresh", { name: "side" }], ["thread_prompt", { name: "side" }]]);
  const shown = dialog("Prompt for “The lighthouse”");
  expect([...(shown?.querySelectorAll("details.prompt-part pre") ?? [])].map((pre) => pre.textContent)).toEqual(["Ada sails."]);
  expect([shown?.querySelector("[aria-label='Saved pins']"), button(shown ?? document.body, "Refresh now").disabled]).toEqual([null, false]);
  await view.unmount();

  app.answer((request) => {
    if (request["name"] === "thread_prompt_refresh") throw new Error("the workspace helper is down");
    if (request["name"] === "thread_prompt") return VIEW;
    return undefined;
  });
  const failing = await settings(SIDE);
  await click(button(document.body, "View prompt…"));
  await click(button(dialog("Prompt for “The lighthouse”") ?? document.body, "Refresh now"));
  await settle();
  expect(dialog("Prompt for “The lighthouse”")?.querySelector(".prompt-refresh [role=alert]")?.textContent).toBe("the workspace helper is down");
  app.answer((request) => {
    if (request["name"] === "thread_prompt_refresh") return fresh;
    if (request["name"] === "thread_prompt") return VIEW;
    return undefined;
  });
  await click(button(dialog("Prompt for “The lighthouse”") ?? document.body, "Refresh now"));
  await settle();
  expect(dialog("Prompt for “The lighthouse”")?.querySelector(".prompt-refresh [role=alert]")).toBeNull();
  await failing.unmount();

  app.answer((request) => {
    if (request["name"] === "thread_prompt_refresh") return HOLD;
    if (request["name"] === "thread_prompt") return { ...VIEW, thread: "story" };
    return undefined;
  });
  const held = await settings(SIDE);
  await click(button(document.body, "View prompt…"));
  const before = app.socket().sent.length;
  await click(button(dialog("Prompt for “The lighthouse”") ?? document.body, "Refresh now"));
  expect(button(dialog("Prompt for “The lighthouse”") ?? document.body, "Refreshing…").disabled).toBe(true);
  const rid = app.sent(before).find((request) => request["name"] === "thread_prompt_refresh")?.["rid"];
  await acting(() => {
    app.socket().receive({ type: "command_output", rid, name: "thread_prompt_refresh", data: VIEW });
    app.socket().receive({ type: "request_finished", rid, outcome: "completed" });
  });
  await settle();
  expect(button(dialog("Prompt for “The lighthouse”") ?? document.body, "Refresh now").disabled).toBe(false);
  await held.unmount();

  const { conversation } = app.state();
  await acting(() => { void conversation.submit("message", { text: "hello" }).catch(() => undefined); });
  const replying = await settings(HOME);
  await click(button(document.body, "View prompt…"));
  expect(button(dialog("Prompt for “story”") ?? document.body, "Refresh now").disabled).toBe(true);
  await replying.unmount();
  const other = await settings(SIDE);
  await click(button(document.body, "View prompt…"));
  expect(button(dialog("Prompt for “The lighthouse”") ?? document.body, "Refresh now").disabled).toBe(false);
  await other.unmount();
});
