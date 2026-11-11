import { expect, test } from "bun:test";

import { useApp } from "./app.ts";
import { acting, mount } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };

test("the sidebar lists the characters with the open one's threads, and under them settings, the user's status and the connection", async () => {
  app.answer((request) => request["name"] === "presence" ? { status: "busy", set_at: "2026-10-30T12:00:00.000Z", choices: ["asleep", "busy"] } : undefined);
  const { Sidebar } = await import("../../src/browser/sidebar/Sidebar.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const state = chromeOf(undefined, app.state().workspace.getSnapshot());
  expect(state.status).toBe("ready");
  const since = app.socket().sent.length;
  const view = await mount(<Sidebar state={state} mobile={false} close={() => {}} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} />);
  await settle();

  const sidebar = view.host.querySelector("aside.sidebar");
  expect(sidebar?.getAttribute("aria-label")).toBe("Characters and threads");
  expect(sidebar?.querySelector(".wordmark")?.textContent).toBe("shore");
  expect([...(sidebar?.querySelectorAll(".sidebar-list .sidebar-item.character .sidebar-name") ?? [])].map((name) => name.textContent)).toEqual(["ada"]);
  expect([...(sidebar?.querySelector(".sidebar-footer")?.children ?? [])].map((part) => part.textContent)).toEqual(["Settings", "busy", "Connected"]);
  expect(app.sent(since).filter((request) => request["name"] === "presence").map((request) => request["args"])).toEqual([{}]);
});

test("a status the daemon refuses is shown to the user as an error", async () => {
  app.answer((request) => {
    if (request["name"] !== "presence") return undefined;
    const asked = (request["args"] as { status?: string }).status;
    if (asked !== undefined) throw new Error("\"busy\" isn't one of your statuses");
    return { choices: ["asleep", "busy"] };
  });
  const { Sidebar } = await import("../../src/browser/sidebar/Sidebar.tsx");
  const { chromeOf } = await import("../../src/browser/chrome.ts");
  const { toasts, Toasts } = await import("../../src/browser/ui/toast.tsx");
  const view = await mount(<div><Sidebar state={chromeOf(undefined, app.state().workspace.getSnapshot())} mobile={false} close={() => {}} collapse={() => {}} newCharacter={() => {}} newThread={() => {}} /><Toasts /></div>);
  await settle();
  const chip = [...view.host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Your status");
  expect(chip?.textContent).toBe("Set status");
  await acting(() => { chip?.click(); });
  const busy = [...view.host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")].find((item) => item.textContent === "busy");
  await acting(() => { busy?.click(); });
  await settle();
  const refusals = [...view.host.querySelectorAll(".toast.error")].filter((toast) => toast.textContent.includes("isn't one of your statuses"));
  expect(refusals.map((toast) => toast.getAttribute("role"))).toEqual(["alert"]);
  expect(chip?.textContent).toBe("Set status");
  await acting(() => { for (const shown of toasts.getSnapshot()) toasts.dismiss(shown.id); });
});
