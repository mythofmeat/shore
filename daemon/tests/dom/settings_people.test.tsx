import { describe, expect, jest, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const details = (extra: Record<string, unknown> = {}) => ({
  name: "ada", active: true, config_dir: "/cfg/ada", workspace_dir: "/ws/ada", has_definition: true, definition_preview: "You are Ada.", bootstrap_files: ["A.md", "B.md"],
  has_config_override: true, pending_deferred_edits: ["C.md"], data_dir: "/data/ada", has_data: true, ...extra,
});

describe("the devices page", () => {
  test("starts from this page's address, says which addresses won't do, and remembers what was typed", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    const input = view.host.querySelector("input");
    const show = button(view.host, "Show sign-in code");
    expect([input?.value, input?.placeholder, show.disabled]).toEqual(["http://shore.test:7340", "my-computer:7340", false]);
    await type(input, "not a place/with/path");
    expect([view.host.querySelector("[role=alert]")?.textContent, show.disabled]).toEqual(["Enter an address such as my-computer:7340 or https://my-computer.example.", true]);
    await type(input, "   ");
    expect(view.host.querySelector("[role=alert]"), "nothing typed is not wrong").toBeNull();
    await type(input, "localhost:7340");
    expect(view.host.querySelector(".setting-description")?.textContent).toBe("http://localhost:7340 only reaches this computer. Enter an address the other device can reach, such as this computer’s network or tailnet name.");
    expect(localStorage.getItem("shore.device-address")).toBe("localhost:7340");
    await type(input, "desktop.lan");
    expect(view.host.textContent).not.toContain("only reaches this computer");
    await view.unmount();
    const again = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    expect(again.host.querySelector("input")?.value).toBe("desktop.lan");
    localStorage.clear();
  });

  test("shows a one-time code as a link and QR code that counts down to its expiry, and copies the link", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    jest.useFakeTimers();
    app.restores.push(() => { jest.useRealTimers(); });
    const start = new Date("2026-11-10T00:00:00Z").getTime();
    jest.setSystemTime(start);
    const codes = spyOn(app.state().workspace.connection, "loginCode").mockImplementation(async () => await Promise.resolve({ code: "c0de", expires_at: Date.now() + 65_000 }));
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { await Promise.resolve(); written.push(text); } } });
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { codes.mockRestore(); shown.mockRestore(); Reflect.deleteProperty(navigator, "clipboard"); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await type(view.host.querySelector("input"), "desktop.lan");
    await click(button(view.host, "Show sign-in code"));
    await acting(() => Promise.resolve());
    expect([view.host.querySelector(".login-code-link")?.textContent, view.host.querySelector("svg.qr-code")?.getAttribute("aria-label")]).toEqual(["http://desktop.lan:7340/#login=c0de", "Sign-in code"]);
    expect(view.host.textContent).toContain("Expires in 1:05");
    expect(button(view.host, "New code").disabled).toBe(false);
    await acting(() => { jest.advanceTimersByTime(1000); });
    expect(view.host.textContent).toContain("Expires in 1:04");
    await click(button(view.host, "Copy link"));
    await acting(() => Promise.resolve());
    expect([written, shown.mock.calls.at(-1)]).toEqual([["http://desktop.lan:7340/#login=c0de"], ["Link copied"]]);
    await acting(() => { jest.advanceTimersByTime(64_000); });
    expect([view.host.querySelector(".login-code-link"), view.host.textContent?.includes("That code expired. Show a new one.")]).toEqual([null, true]);
    await view.unmount();
    localStorage.clear();
  });
});

describe("the characters page", () => {
  test("lists the characters, marks the active one, and shows the chosen one's details", async () => {
    const { CharactersPage } = await import("../../src/browser/settings/Characters.tsx");
    app.answer((request) => request["name"] === "character_info" ? details({ name: (request["args"] as { name: string }).name }) : undefined);
    const snapshot = { ...app.state().workspace.getSnapshot(), character: "bo", characters: [{ name: "ada" }, { name: "bo" }] };
    const view = await mount(<CharactersPage state={snapshot} />);
    const options = () => [...view.host.querySelectorAll("[role=option]")].map((option) => [option.textContent, option.getAttribute("aria-selected"), option.className]);
    expect(options()).toEqual([["Aada", "false", "character-card "], ["Bboactive", "true", "character-card on"]]);
    await acting(() => Bun.sleep(5));
    const facts = () => [...view.host.querySelectorAll(".kv-row")].map((row) => `${row.querySelector("dt")?.textContent ?? ""}: ${row.querySelector("dd")?.textContent ?? ""}`);
    expect(facts()).toEqual(["Definition: Set", "Configuration: Has its own overrides", "Workspace: /ws/ada", "Config folder: /cfg/ada", "Data folder: /data/ada", "Bootstrap files: A.md, B.md", "Pending edits: C.md"]);
    expect(view.host.querySelector("pre.readout")?.textContent).toBe("You are Ada.");
    expect(view.host.querySelector(".settings-section:nth-of-type(2) h2")?.textContent).toBe("bo");
    expect(() => button(view.host, "Open threads"), "the active character is already open").toThrow();
    await click(view.host.querySelector("[role=option]"));
    await acting(() => Bun.sleep(5));
    expect(options()[0]?.[1]).toBe("true");
    expect(button(view.host, "Open threads").className).toBe("button");
    await view.update(<CharactersPage state={{ ...snapshot, characters: [{ name: "bo" }, { name: "cy" }] }} />);
    expect(options().map(([name, chosen]) => [name, chosen]), "a chosen character that is gone falls back to the first").toEqual([["Bboactive", "true"], ["Ccy", "false"]]);
  });

  test("shows a fresh character's plainer details, and a failure to load them", async () => {
    const { CharactersPage } = await import("../../src/browser/settings/Characters.tsx");
    const snapshot = { ...app.state().workspace.getSnapshot(), character: null, characters: [{ name: "ada" }] };
    app.answer((request) => request["name"] === "character_info" ? HOLD : undefined);
    const waiting = await mount(<CharactersPage state={snapshot} />);
    expect(waiting.host.querySelector("[aria-label='Loading character']")).not.toBeNull();
    await waiting.unmount();
    app.answer((request) => request["name"] === "character_info" ? details({ has_definition: false, has_config_override: false, has_data: false, bootstrap_files: [], pending_deferred_edits: [], definition_preview: null }) : undefined);
    const view = await mount(<CharactersPage state={snapshot} />);
    await acting(() => Bun.sleep(5));
    expect([...view.host.querySelectorAll(".kv-row dd")].map((dd) => dd.textContent)).toEqual(["Not written yet", "Uses the shared configuration", "/ws/ada", "/cfg/ada", "No data yet"]);
    expect([view.host.querySelector("pre.readout"), view.host.querySelector(".tag")]).toEqual([null, null]);
    app.answer((request) => { if (request["name"] === "character_info") throw new Error("no such character"); return undefined; });
    const failing = await mount(<CharactersPage state={snapshot} />);
    await acting(() => Bun.sleep(5));
    expect([failing.host.querySelector("[role=alert]")?.textContent, failing.host.querySelector("[aria-label='Loading character']")]).toEqual(["no such character", null]);
    const empty = await mount(<CharactersPage state={{ ...snapshot, characters: [] }} />);
    expect([empty.host.querySelector(".settings-empty")?.textContent, empty.host.querySelectorAll(".settings-section").length]).toEqual(["No characters yet.", 1]);
  });

  test("opens another character's threads, and offers a new character", async () => {
    const { CharactersPage } = await import("../../src/browser/settings/Characters.tsx");
    app.answer((request) => request["name"] === "character_info" ? details() : request["name"] === "switch_character" ? { character: "ada", changed: true } : undefined);
    const snapshot = { ...app.state().workspace.getSnapshot(), character: "bo", characters: [{ name: "ada" }, { name: "bo" }] };
    const opens = spyOn(app.state().workspace, "openCharacter");
    app.restores.push(() => { opens.mockRestore(); });
    const view = await mount(<CharactersPage state={{ ...snapshot }} />);
    await click(view.host.querySelector("[role=option]"));
    await acting(() => Bun.sleep(5));
    location.hash = "#settings/characters";
    await click(button(view.host, "Open threads"));
    expect([location.hash, opens.mock.calls]).toEqual(["", [["ada"]]]);
    await click(button(view.host, "New character"));
    expect(view.host.querySelector("dialog")?.open).toBe(true);
  });

  test("deletes a character only once its name is typed, saving an archive when asked, and says so", async () => {
    const { CharactersPage } = await import("../../src/browser/settings/Characters.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const deletions: unknown[] = [];
    app.answer((request) => {
      if (request["name"] === "character_info") return details();
      if (request["name"] !== "delete_character") return undefined;
      const args = request["args"] as { character: string; archive?: string };
      deletions.push(args);
      return { character: args.character, deleted: true, removed: [], archive: args.archive ?? null };
    });
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); });
    const snapshot = { ...app.state().workspace.getSnapshot(), character: "ada", characters: [{ name: "ada" }] };
    for (const archive of ["", "  ~/backups/ada.shore  "]) {
      const view = await mount(<CharactersPage state={snapshot} />);
      await acting(() => Bun.sleep(5));
      await click(button(view.host, "Delete…"));
      const dialog = view.host.querySelector("dialog");
      expect(dialog?.querySelector("h2")?.textContent).toBe("Delete ada?");
      const submit = button(dialog ?? view.host, "Delete character");
      expect(submit.disabled).toBe(true);
      const [archiveInput, confirmInput] = [...(dialog?.querySelectorAll("input") ?? [])];
      await type(archiveInput, archive);
      await type(confirmInput, "ad");
      expect(submit.disabled).toBe(true);
      await type(confirmInput, "ada");
      expect(submit.disabled).toBe(false);
      await acting(async () => { dialog?.querySelector("form")?.requestSubmit(); await Bun.sleep(5); });
      expect(view.host.querySelector("dialog")).toBeNull();
      await view.unmount();
    }
    expect(deletions).toEqual([{ character: "ada", confirm: "ada" }, { character: "ada", confirm: "ada", archive: "~/backups/ada.shore" }]);
    expect(shown.mock.calls.map(([text]) => text)).toEqual(["Deleted ada", "Deleted ada; archive saved to ~/backups/ada.shore"]);
    const view = await mount(<CharactersPage state={snapshot} />);
    await acting(() => Bun.sleep(5));
    await click(button(view.host, "Delete…"));
    await click(button(view.host.querySelector("dialog") ?? view.host, "Cancel"));
    expect(view.host.querySelector("dialog")).toBeNull();
  });
});
