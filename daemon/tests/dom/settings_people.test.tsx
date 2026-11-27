import { describe, expect, jest, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();

const details = (extra: Record<string, unknown> = {}) => ({
  name: "ada", active: true, config_dir: "/cfg/ada", workspace_dir: "/ws/ada", prompt_files: ["A.md", "B.md"],
  has_config_override: true, pending_deferred_edits: ["C.md"], data_dir: "/data/ada", has_data: true, ...extra,
});

const NOW = new Date("2026-11-10T00:00:00Z").getTime();
const devices = () => ({
  devices: [
    { id: "b1", kind: "browser" as const, name: "Firefox on Linux", created_at: 0, last_used_at: NOW - 30_000, expires_at: NOW + 1, current: true },
    { id: "c1", kind: "cli" as const, name: "desktop", created_at: 0, last_used_at: NOW - 3 * 3_600_000, current: false },
    { id: "k1", kind: "automation" as const, name: "Phone", created_at: 0, operations: ["presence", "status"], current: false },
  ],
});

function stubDevices(list = devices(), passwordSet = true) {
  const connection = app.state().workspace.connection;
  const listed = spyOn(connection, "devices").mockImplementation(async () => await Promise.resolve(list));
  const asked = spyOn(connection, "signInState").mockImplementation(async () => await Promise.resolve({ password_set: passwordSet }));
  const chosen = spyOn(connection, "choosePassword").mockImplementation(async () => { await Promise.resolve(); });
  const changed = spyOn(connection, "changePassword").mockImplementation(async () => { await Promise.resolve(); });
  const revoked = spyOn(connection, "revokeDevice").mockImplementation(async () => { await Promise.resolve(); });
  const made = spyOn(connection, "automationKey").mockImplementation(async (name, operations) => await Promise.resolve({
    device: { id: "k2", kind: "automation" as const, name, created_at: NOW, operations: [...operations], current: false }, token: "shore_secret-key",
  }));
  app.restores.push(() => { listed.mockRestore(); asked.mockRestore(); chosen.mockRestore(); changed.mockRestore(); revoked.mockRestore(); made.mockRestore(); });
  return { listed, asked, chosen, changed, revoked, made };
}

const passwordSection = (host: HTMLElement) => [...host.querySelectorAll(".settings-section")].find((section) => section.querySelector("h2")?.textContent === "Password") ?? host;
const field = (host: HTMLElement, label: string) => [...passwordSection(host).querySelectorAll("label.field")].find((item) => item.querySelector("span")?.textContent === label)?.querySelector("input") ?? null;

describe("the devices page", () => {
  test("lists every signed-in device with what it is and when it was last used, and signs one out", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    jest.useFakeTimers();
    app.restores.push(() => { jest.useRealTimers(); });
    jest.setSystemTime(NOW);
    const stub = stubDevices();
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await acting(() => Promise.resolve());
    const rows = [...view.host.querySelectorAll(".setting-row")].map((row) => [row.querySelector(".setting-label")?.textContent, row.querySelector(".setting-description")?.textContent]);
    expect(rows).toEqual([
      ["Firefox on Linux · this one", "Browser · used just now"],
      ["desktop", "Command line · used 3 h ago"],
      ["Phone", "Automation key for presence, status · not used yet"],
    ]);
    await click(view.host.querySelectorAll(".setting-row button")[1]);
    await acting(() => Promise.resolve());
    expect(stub.revoked.mock.calls).toEqual([["c1"]]);
    const before = stub.listed.mock.calls.length;
    await acting(() => { jest.advanceTimersByTime(5_000); });
    expect(stub.listed.mock.calls.length).toBeGreaterThan(before);
    await view.unmount();
  });

  test("changes the password with the current one and the new one typed twice, and says it did", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const stub = stubDevices();
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await acting(() => Promise.resolve());
    const section = passwordSection(view.host);
    expect(section.querySelector(".setting-description, p")?.textContent).toBe("Every browser and command line signs in with this password. Changing it leaves everything below signed in; sign out any you don’t trust.");
    expect([...section.querySelectorAll("input")].map((input) => [input.type, input.autocomplete])).toEqual([["password", "current-password"], ["password", "new-password"], ["password", "new-password"]]);
    const change = button(section, "Change password");
    expect(change.disabled).toBe(true);
    await type(field(view.host, "New password"), "battery staple");
    await type(field(view.host, "Type it again"), "battery stapler");
    expect([section.querySelector("[role=alert]")?.textContent, change.disabled]).toEqual(["The two passwords differ.", true]);
    await type(field(view.host, "Type it again"), "battery staple");
    expect([section.querySelector("[role=alert]"), change.disabled], "the current one is still missing").toEqual([null, true]);
    await type(field(view.host, "Current password"), "correct horse");
    await click(change);
    await acting(() => Promise.resolve());
    expect([stub.changed.mock.calls, stub.chosen.mock.calls, shown.mock.calls.at(-1)]).toEqual([[["correct horse", "battery staple"]], [], ["Password changed"]]);
    expect([...section.querySelectorAll("input")].map((input) => input.value), "the fields start over").toEqual(["", "", ""]);
    await view.unmount();
  });

  test("with no password yet, one is chosen without a current one, and then the section asks for it", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const stub = stubDevices(devices(), false);
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await acting(() => Promise.resolve());
    const section = passwordSection(view.host);
    expect(section.textContent).toContain("This daemon has no password yet. Choose one, and any browser or command line can sign in with it.");
    expect(field(view.host, "Current password")).toBeNull();
    await type(field(view.host, "New password"), "first pass");
    await type(field(view.host, "Type it again"), "first pass");
    await click(button(section, "Set password"));
    await acting(() => Promise.resolve());
    expect([stub.chosen.mock.calls, stub.changed.mock.calls, shown.mock.calls.at(-1)]).toEqual([[["first pass"]], [], ["Password set"]]);
    expect(field(view.host, "Current password"), "now there is one to give").not.toBeNull();
    expect(button(section, "Change password").disabled).toBe(true);
    await type(field(view.host, "Current password"), "first pass");
    expect(button(section, "Change password").disabled, "a current one alone changes nothing").toBe(true);
    await view.unmount();
  });

  test("the password can't be saved twice at once", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const stub = stubDevices(devices(), false);
    let release = (): void => {};
    stub.chosen.mockImplementation(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await acting(() => Promise.resolve());
    await type(field(view.host, "New password"), "first pass");
    await type(field(view.host, "Type it again"), "first pass");
    await click(button(passwordSection(view.host), "Set password"));
    expect(button(passwordSection(view.host), "Set password").disabled, "busy while it is saved").toBe(true);
    release();
    await acting(() => Promise.resolve());
    expect(stub.chosen.mock.calls).toHaveLength(1);
    await view.unmount();
  });

  test("until the daemon says whether it has a password, nothing can be saved, and a refused change says why", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const stub = stubDevices();
    stub.asked.mockImplementation(async () => { await Promise.resolve(); throw new Error("offline"); });
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await acting(() => Promise.resolve());
    await type(field(view.host, "New password"), "first pass");
    await type(field(view.host, "Type it again"), "first pass");
    expect(button(passwordSection(view.host), "Set password").disabled).toBe(true);
    await view.unmount();
    stub.asked.mockImplementation(async () => await Promise.resolve({ password_set: true }));
    stub.changed.mockImplementation(async () => { await Promise.resolve(); throw new Error("That password isn’t right"); });
    const again = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await acting(() => Promise.resolve());
    await type(field(again.host, "Current password"), "not it");
    await type(field(again.host, "New password"), "battery staple");
    await type(field(again.host, "Type it again"), "battery staple");
    await click(button(passwordSection(again.host), "Change password"));
    await acting(() => Promise.resolve());
    expect(shown.mock.calls.at(-1)).toEqual(["That password isn’t right", "error"]);
    expect(field(again.host, "Current password")?.value, "nothing is cleared").toBe("not it");
    await again.unmount();
  });

  test("makes an automation key for the ticked operations and shows it once, with how to use it", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const stub = stubDevices();
    const snapshot = { ...app.state().workspace.getSnapshot(), operations: [
      { name: "presence", label: "Your status" }, { name: "switch_thread", label: "Switch thread" }, { name: "status", label: "Status" },
    ] as never, requests: [{ name: "message", label: "Send message" }] as never };
    const view = await mount(<DevicesPage state={snapshot} />);
    const make = button(view.host, "Make key");
    expect(make.disabled).toBe(true);
    const labels = [...view.host.querySelectorAll(".key-operations label")].map((label) => label.textContent);
    expect(labels).toEqual(["Send message message", "Your status presence", "Status status"]);
    await type(view.host.querySelector("input[placeholder='Phone shortcuts']"), "Phone");
    expect(make.disabled, "a key needs an operation").toBe(true);
    await click(view.host.querySelectorAll(".key-operations input")[1]);
    await click(button(view.host, "Make key"));
    await acting(() => Promise.resolve());
    expect(stub.made.mock.calls).toEqual([["Phone", ["presence"]]]);
    expect(view.host.querySelector(".key-example")?.textContent).toBe("curl -X POST http://shore.test:7340/api/op/presence \\\n  -H \"Authorization: Bearer shore_secret-key\" \\\n  -H \"Content-Type: application/json\" -d '{}'");
    await click(button(view.host, "Done"));
    expect(view.host.querySelector(".key-example")).toBeNull();
    await view.unmount();
  });

  test("starts from this page's address, says which addresses won't do, and remembers what was typed", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    stubDevices({ devices: [] });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    const input = view.host.querySelector<HTMLInputElement>("input.mono");
    const show = button(view.host, "Show sign-in code");
    expect([input?.value, input?.placeholder, show.disabled]).toEqual(["http://shore.test:7340", "my-computer:7340", false]);
    await type(input, "not a place/with/path");
    expect([view.host.querySelector("[role=alert]")?.textContent, show.disabled]).toEqual(["Enter an address such as my-computer:7340 or https://my-computer.example.", true]);
    await type(input, "   ");
    expect(view.host.querySelector("[role=alert]"), "nothing typed is not wrong").toBeNull();
    await type(input, "localhost:7340");
    expect(view.host.querySelector(".rows.padded .setting-description")?.textContent).toBe("http://localhost:7340 only reaches this computer. Enter an address the other device can reach, such as this computer’s network or tailnet name.");
    expect(localStorage.getItem("shore.device-address")).toBe("localhost:7340");
    await type(input, "desktop.lan");
    expect(view.host.textContent).not.toContain("only reaches this computer");
    await view.unmount();
    const again = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    expect(again.host.querySelector<HTMLInputElement>("input.mono")?.value).toBe("desktop.lan");
    localStorage.clear();
  });

  test("shows a one-time code as a link and QR code that counts down to its expiry, and copies the link", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    jest.useFakeTimers();
    app.restores.push(() => { jest.useRealTimers(); });
    const start = new Date("2026-11-10T00:00:00Z").getTime();
    jest.setSystemTime(start);
    stubDevices({ devices: [] });
    const codes = spyOn(app.state().workspace.connection, "loginCode").mockImplementation(async () => await Promise.resolve({ code: "c0de", expires_at: Date.now() + 65_000 }));
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { await Promise.resolve(); written.push(text); } } });
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { codes.mockRestore(); shown.mockRestore(); Reflect.deleteProperty(navigator, "clipboard"); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await type(view.host.querySelector<HTMLInputElement>("input.mono"), "desktop.lan");
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

  test("says when a device was last used in minutes, hours or as a date, and counts down to the second", async () => {
    const { countdown, lastUsed } = await import("../../src/browser/settings/Devices.tsx");
    const at = NOW - 1;
    expect([undefined, 0].map((when) => lastUsed(when, NOW))).toEqual(["not used yet", "not used yet"]);
    expect([59_999, 60_000, 3_599_999, 3_600_000, 86_399_999, 86_400_000].map((ago) => lastUsed(at, at + ago))).toEqual([
      "used just now", "used 1 min ago", "used 59 min ago", "used 1 h ago", "used 23 h ago", `used ${new Date(at).toLocaleDateString()}`,
    ]);
    expect([-1_000, 0, 59_000, 60_000, 60_001, 65_000].map(countdown)).toEqual(["0:00", "0:00", "0:59", "1:00", "1:01", "1:05"]);
  });

  test("looks again at once after signing a device out, and says it did", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const stub = stubDevices(devices());
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await acting(() => Promise.resolve());
    expect([...view.host.querySelectorAll("h2")].map((title) => title.textContent)).toEqual(["Password", "Signed in", "Sign in a browser", "New automation key"]);
    const before = stub.listed.mock.calls.length;
    const rows = [...view.host.querySelectorAll(".setting-row")].filter((row) => row.querySelector(".setting-label")?.textContent === "desktop");
    await click(button(rows[0] ?? view.host, "Sign out"));
    await acting(() => Promise.resolve());
    expect([stub.listed.mock.calls.length, shown.mock.calls.at(-1)]).toEqual([before + 1, ["desktop is signed out"]]);
    await view.unmount();
  });

  test("a list that can't be read says why until one can, and each new list is timed from when it came", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    jest.useFakeTimers();
    app.restores.push(() => { jest.useRealTimers(); });
    jest.setSystemTime(NOW);
    const answers: (() => Promise<unknown>)[] = [async () => { await Promise.resolve(); throw new Error("Keys can't list devices"); }, async () => { await Promise.resolve(); throw "plainly not"; }];
    const list = { devices: [{ id: "c1", kind: "cli" as const, name: "desktop", created_at: 0, last_used_at: NOW, current: false }] };
    const listed = spyOn(app.state().workspace.connection, "devices").mockImplementation(async () => await ((answers.shift() ?? (async () => await Promise.resolve(list)))() as Promise<typeof list>));
    app.restores.push(() => { listed.mockRestore(); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    await acting(() => Promise.resolve());
    expect(view.host.querySelector("[role=alert]")?.textContent).toBe("Keys can't list devices");
    await acting(() => { jest.advanceTimersByTime(5_000); });
    await acting(() => Promise.resolve());
    expect(view.host.querySelector("[role=alert]")?.textContent).toBe("plainly not");
    jest.setSystemTime(NOW + 2 * 3_600_000);
    await acting(() => { jest.advanceTimersByTime(5_000); });
    await acting(() => Promise.resolve());
    expect([view.host.querySelector("[role=alert]"), view.host.querySelector(".setting-row .setting-description")?.textContent]).toEqual([null, "Command line · used 2 h ago"]);
    await view.unmount();
    const after = listed.mock.calls.length;
    await acting(() => { jest.advanceTimersByTime(20_000); });
    expect(listed.mock.calls.length).toBe(after);
  });

  test("making a key takes the ticked operations, waits while it works, starts over after, and copies the key", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    const { toasts } = await import("../../src/browser/ui/toast.tsx");
    const stub = stubDevices();
    let release = (): void => {};
    stub.made.mockImplementation(async (name, operations) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { device: { id: "k2", kind: "automation" as const, name, created_at: NOW, operations: [...operations], current: false }, token: "shore_secret-key" };
    });
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { await Promise.resolve(); written.push(text); } } });
    const shown = spyOn(toasts, "show");
    app.restores.push(() => { shown.mockRestore(); Reflect.deleteProperty(navigator, "clipboard"); });
    const snapshot = { ...app.state().workspace.getSnapshot(), operations: [{ name: "presence", label: "Your status" }, { name: "status", label: "Status" }, { name: "usage", label: "Usage" }] as never, requests: [] as never };
    const view = await mount(<DevicesPage state={snapshot} />);
    const boxes = () => [...view.host.querySelectorAll<HTMLInputElement>(".key-operations input")];
    const nameField = () => view.host.querySelector<HTMLInputElement>("input[placeholder='Phone shortcuts']");
    await type(nameField(), "   ");
    await click(boxes()[0]);
    expect(button(view.host, "Make key").disabled, "a blank name is no name").toBe(true);
    await type(nameField(), "Phone");
    await click(boxes()[1]);
    await click(boxes()[2]);
    await click(boxes()[2]);
    const listedBefore = stub.listed.mock.calls.length;
    await click(button(view.host, "Make key"));
    expect(button(view.host, "Make key").disabled, "busy while the key is made").toBe(true);
    release();
    await acting(() => Promise.resolve());
    await acting(() => Promise.resolve());
    expect(stub.made.mock.calls).toEqual([["Phone", ["presence", "status"]]]);
    expect([nameField()?.value, boxes().map((box) => box.checked), stub.listed.mock.calls.length > listedBefore]).toEqual(["", [false, false, false], true]);
    expect(view.host.querySelector(".key-example")?.textContent).toStartWith("curl -X POST http://shore.test:7340/api/op/presence ");
    await click(button(view.host, "Copy key"));
    await acting(() => Promise.resolve());
    expect([written, shown.mock.calls.at(-1)]).toEqual([["shore_secret-key"], ["Key copied"]]);
    await view.unmount();
  });

  test("ticks a second only while a code is shown, from the moment it was shown, and a code is over at its expiry", async () => {
    const { DevicesPage } = await import("../../src/browser/settings/Devices.tsx");
    jest.useFakeTimers();
    app.restores.push(() => { jest.useRealTimers(); });
    jest.setSystemTime(NOW);
    stubDevices({ devices: [] });
    const codes = spyOn(app.state().workspace.connection, "loginCode").mockImplementation(async () => await Promise.resolve({ code: "c0de", expires_at: Date.now() + 300_000 }));
    const set = spyOn(globalThis, "setInterval");
    const cleared = spyOn(globalThis, "clearInterval");
    app.restores.push(() => { codes.mockRestore(); set.mockRestore(); cleared.mockRestore(); });
    const view = await mount(<DevicesPage state={app.state().workspace.getSnapshot()} />);
    const input = view.host.querySelector<HTMLInputElement>("input.mono");
    expect([input?.getAttribute("spellcheck"), view.host.textContent?.includes("That code expired")]).toEqual(["false", false]);
    await type(input, "desktop.lan");
    expect(set.mock.calls.filter((call) => call[1] === 1000)).toEqual([]);
    jest.setSystemTime(NOW + 600_000);
    await click(button(view.host, "Show sign-in code"));
    await acting(() => Promise.resolve());
    expect(view.host.textContent).toContain("Expires in 5:00");
    const tickers = set.mock.calls.flatMap((call, at) => call[1] === 1000 ? [set.mock.results[at]?.value as ReturnType<typeof setInterval>] : []);
    expect(tickers.length).toBeGreaterThan(0);
    await type(input, "not a place/with/path");
    expect([view.host.querySelector(".login-code-link"), view.host.textContent?.includes("That code expired")]).toEqual([null, false]);
    await type(input, "desktop.lan");
    jest.setSystemTime(NOW + 900_000);
    await acting(() => { jest.advanceTimersByTime(1000); });
    expect([view.host.querySelector(".login-code-link"), view.host.textContent?.includes("That code expired. Show a new one.")]).toEqual([null, true]);
    const shown = set.mock.calls.flatMap((call, at) => call[1] === 1000 ? [set.mock.results[at]?.value as ReturnType<typeof setInterval>] : []);
    await view.unmount();
    for (const ticker of [...tickers, ...shown]) expect(cleared.mock.calls.some(([handle]) => handle === ticker), "the ticker is the one stopped").toBe(true);
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
    expect([...view.host.querySelectorAll<HTMLElement>(".character-card .avatar")].map((avatar) => [avatar.style.width, avatar.style.height])).toEqual([["40px", "40px"], ["40px", "40px"]]);
    expect(view.host.querySelector("dialog"), "nothing is being made or deleted yet").toBeNull();
    await acting(() => Bun.sleep(5));
    const facts = () => [...view.host.querySelectorAll(".kv-row")].map((row) => `${row.querySelector("dt")?.textContent ?? ""}: ${row.querySelector("dd")?.textContent ?? ""}`);
    expect(facts()).toEqual(["Configuration: Has its own overrides", "Workspace: /ws/ada", "Config folder: /cfg/ada", "Data folder: /data/ada", "Prompt files: A.md, B.md", "Pending edits: C.md"]);
    expect([...view.host.querySelectorAll(".kv-row dd")].map((dd) => dd.className)).toEqual(["", "mono", "mono", "mono", "mono", "mono"]);
    expect(view.host.querySelector(".settings-description")?.textContent).toBe("Characters on this daemon, one for each folder in the config folder’s characters folder. What their prompt is made of is the [[prompt]] list in the configuration.");
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
    const snapshot = { ...app.state().workspace.getSnapshot(), character: null, characters: [{ name: "ada" }, { name: "bo" }] };
    app.answer((request) => request["name"] === "character_info" ? HOLD : undefined);
    const waiting = await mount(<CharactersPage state={snapshot} />);
    expect(waiting.host.querySelector("[aria-label='Loading character']")).not.toBeNull();
    await waiting.unmount();
    app.answer((request) => request["name"] === "character_info" ? details({ has_config_override: false, has_data: false, prompt_files: [], pending_deferred_edits: [] }) : undefined);
    const view = await mount(<CharactersPage state={snapshot} />);
    await acting(() => Bun.sleep(5));
    expect([...view.host.querySelectorAll("[role=option]")].map((option) => option.getAttribute("aria-selected")), "with none active, the first is chosen").toEqual(["true", "false"]);
    expect([...view.host.querySelectorAll(".kv-row dd")].map((dd) => dd.textContent)).toEqual(["Uses the shared configuration", "/ws/ada", "/cfg/ada", "No data yet", "None in the workspace"]);
    expect(view.host.querySelectorAll(".kv-row dd")[4]?.className).toBe("");
    expect(view.host.querySelector(".tag")).toBeNull();
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
    await click(button(view.host, "Cancel"));
    expect(view.host.querySelector("dialog")).toBeNull();
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
