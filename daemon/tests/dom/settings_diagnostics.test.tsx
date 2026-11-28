import { describe, expect, test } from "bun:test";

import { useApp } from "./app.ts";
import { acting, mount } from "./dom.ts";

const app = useApp();
const settle = async () => { await acting(() => Bun.sleep(5)); };

const report = {
  character: "ada", keepalive_halts: [], turn_count: 3, active_model: "anthropic:opus",
  config_dir: "/config", data_dir: "/data", cache_dir: "/cache",
  pending_deferred_edit_count: 0, pending_deferred_edits: [],
  tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  autonomy: null, activity: null, history_index: null,
  triggers: {
    enabled: true,
    next_wake: { trigger: "lamp", at: "2026-11-18T13:00:00+00:00" },
    triggers: [{ name: "lamp", does: 'every 1h, wakes ada, "Trim the lamp."', status: "never fired" }],
    not_running: ["`tide` isn't running: no reason"],
    asked: [],
  },
  sections: ["tokens", "autonomy", "triggers", "activity", "history_index"],
};

describe("the diagnostics page", () => {
  test("shows the character's triggers as a status section of their own", async () => {
    const { DiagnosticsPage } = await import("../../src/browser/settings/Diagnostics.tsx");
    app.answer((request) => request["name"] === "status" ? report : undefined);
    const view = await mount(<DiagnosticsPage state={{ ...app.state().workspace.getSnapshot(), character: "ada" }} />);
    await settle();
    const select = view.host.querySelector<HTMLSelectElement>("select[aria-label='Status section']");
    expect([...select?.options ?? []].map((option) => option.value)).toContain("triggers");
    const section = [...view.host.querySelectorAll(".status-section")].find((each) => each.querySelector(".setting-label")?.textContent === "Triggers");
    expect(section?.textContent).toContain('lampDoesevery 1h, wakes ada, "Trim the lamp."Statusnever fired');
    expect(section?.textContent).toContain("Not running`tide` isn't running: no reason");
  });

  test("shows the wakes the character asked for that haven't started, and one that is next as the next wake", async () => {
    const { DiagnosticsPage } = await import("../../src/browser/settings/Diagnostics.tsx");
    const asked = {
      ...report,
      triggers: {
        ...report.triggers,
        next_wake: { trigger: "", thread: "ring", at: "2026-11-18T12:30:00+00:00" },
        asked: [{ thread: "ring", does: 'asked for from "main" at Wednesday 2026-11-18 · 11:00 AM: Tell part two.', status: "starts Wednesday 2026-11-18 · 12:30 PM" }],
      },
    };
    app.answer((request) => request["name"] === "status" ? asked : undefined);
    const view = await mount(<DiagnosticsPage state={{ ...app.state().workspace.getSnapshot(), character: "ada" }} />);
    await settle();
    const section = [...view.host.querySelectorAll(".status-section")].find((each) => each.querySelector(".setting-label")?.textContent === "Triggers");
    expect(section?.textContent).toContain("Next wakeTrigger(empty)ThreadringAt");
    expect(section?.textContent).toContain('AskedThreadring' + 'Doesasked for from "main" at Wednesday 2026-11-18 · 11:00 AM: Tell part two.Statusstarts Wednesday 2026-11-18 · 12:30 PM');
  });
});
