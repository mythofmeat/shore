import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";

import { HOLD, useApp } from "./app.ts";
import { replace } from "./daemon.ts";
import { acting, button, click, mount, type } from "./dom.ts";

const app = useApp();
afterEach(() => { jest.useRealTimers(); });

const MIB = 1024 * 1024;
const LATER = Date.UTC(2026, 10, 11, 9, 30);
const archive = (id: string, extra: Record<string, unknown> = {}) => ({ id, filename: `${id}.tar`, bytes: 1.25 * MIB, expires_at: LATER, phase: "ready", downloadable: true, ...extra });
const list = (archives: unknown[]) => ({ archives, max_upload_bytes: 100 * MIB, max_expanded_bytes: 400 * MIB });
const settle = async () => { await acting(() => Bun.sleep(5)); };
const drain = async () => { await acting(async () => { for (let tick = 0; tick < 50; tick += 1) await Promise.resolve(); }); };
const options = (select: Element | null | undefined) => [...select?.querySelectorAll("option") ?? []].map((option) => [option.getAttribute("value"), option.textContent]);

type Route = (path: string, init: RequestInit) => Response | Promise<Response> | typeof HOLD;

function transfers(first: Route) {
  const sent: { path: string; init: RequestInit }[] = [];
  let route = first;
  const previous = globalThis.fetch;
  replace(app.restores, globalThis, "fetch", async (input: string, init: RequestInit = {}) => {
    const url = input;
    if (!url.startsWith("/api/archives")) return await previous(input, init);
    const path = url.slice("/api/archives".length);
    sent.push({ path, init });
    const answer = route(path, init);
    if (answer !== HOLD) return await answer;
    return await new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener("abort", () => { reject(new DOMException("The upload was stopped.", "AbortError")); }); });
  });
  return { sent, paths: () => sent.map((item) => item.path), serve: (next: Route) => { route = next; } };
}

async function toastSpy() {
  const { toasts } = await import("../../src/browser/ui/toast.tsx");
  const shown = spyOn(toasts, "show");
  app.restores.push(() => { shown.mockRestore(); });
  return () => shown.mock.calls.map(([text, tone]) => [text, tone ?? "info"]);
}

async function page(extra: Record<string, unknown> = {}, flush = settle) {
  const { ArchivesPage } = await import("../../src/browser/settings/Archives.tsx");
  const view = await mount(<ArchivesPage state={{ ...app.state().workspace.getSnapshot(), characters: [{ name: "ada" }, { name: "bo" }], ...extra }} />);
  await flush();
  return view;
}

const size = (bytes: number) => `${(bytes / MIB).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
const alert = (root: ParentNode) => root.querySelector("[role=alert]")?.textContent ?? null;
const describedLimit = (root: ParentNode) => root.querySelector(".settings-section")?.querySelector(".settings-section-head .settings-description")?.textContent ?? null;

describe("the archives page", () => {
  test("lists transfers while connected, every second and a half, and stops once the page is gone", async () => {
    const net = transfers(() => Response.json(list([archive("a")])));
    const idle = await page({ status: "connecting" });
    expect([net.paths(), button(idle.host, "Export and download").disabled, idle.host.querySelector<HTMLInputElement>("input[type=file]")?.disabled, describedLimit(idle.host)]).toEqual([[], true, true, null]);
    await idle.unmount();
    jest.useFakeTimers();
    const view = await page({}, drain);
    expect([net.paths(), describedLimit(view.host), alert(view.host)]).toEqual([["/list"], `Up to ${size(100 * MIB)} per archive.`, null]);
    const wait = async (ms: number) => { await acting(() => { jest.advanceTimersByTime(ms); }); await drain(); };
    await wait(1499);
    expect(net.paths()).toHaveLength(1);
    net.serve(() => Response.json({ message: "disk full" }, { status: 500 }));
    await wait(1);
    expect([net.paths(), alert(view.host)]).toEqual([["/list", "/list"], "disk full"]);
    net.serve(() => Response.json({ archives: "none" }));
    await wait(1500);
    expect(alert(view.host)).toBe("The daemon sent an unexpected archive list. Reload the page.");
    net.serve(() => Response.json(list([])));
    await wait(1500);
    expect([alert(view.host), view.host.querySelector(".archive-list .settings-empty")?.textContent]).toEqual([null, "No transfers. Exports and uploads appear here until they expire or you remove them."]);
    await view.unmount();
    await wait(5000);
    expect(net.paths()).toHaveLength(4);
    let release: (response: Response) => void = () => {};
    net.serve(() => new Promise<Response>((resolve) => { release = resolve; }));
    const second = await page({}, drain);
    expect(net.paths()).toHaveLength(5);
    await second.unmount();
    release(Response.json(list([])));
    await drain();
    await wait(5000);
    expect(net.paths(), "a poll that ends after the page is gone does not start another").toHaveLength(5);
  });

  test("shows each transfer with its state, size and expiry, and only the actions that fit it", async () => {
    const { formatTime } = await import("../../src/browser/settings/shared.tsx");
    const imported = { name: "import_character", data: { character: "bo", archive: "/x.tar", imported: true, external_memory: "none" } };
    transfers(() => Response.json(list([
      archive("down"), archive("up", { downloadable: false }), archive("sending", { phase: "uploading" }), archive("packing", { phase: "exporting" }),
      archive("unpacking", { phase: "importing" }), archive("done", { phase: "imported", result: imported }), archive("broken", { phase: "failed", error: "bad tar" }), archive("unsure", { phase: "uncertain" }),
    ])));
    const view = await page();
    const detail = `${size(1.25 * MIB)} · expires ${formatTime(new Date(LATER).toISOString())}`;
    expect([...view.host.querySelectorAll(".archive")].map((item) => [
      item.getAttribute("aria-label"), item.querySelector(".setting-label")?.textContent, item.querySelector(".status-text")?.className, item.querySelector(".status-text")?.textContent,
      item.querySelector(".archive-main .setting-description")?.textContent, [...item.querySelectorAll("button")].map((action) => action.textContent),
    ])).toEqual([
      ["down.tar", "down.tar", "status-text ok", "Ready to download", detail, ["Download", "Remove"]],
      ["up.tar", "up.tar", "status-text ok", "Uploaded, ready to import", detail, ["Import…", "Remove"]],
      ["sending.tar", "sending.tar", "status-text wait", "Uploading…", detail, []],
      ["packing.tar", "packing.tar", "status-text wait", "Preparing the export…", detail, []],
      ["unpacking.tar", "unpacking.tar", "status-text wait", "Importing…", detail, []],
      ["done.tar", "done.tar", "status-text ok", "Imported bo", detail, ["Remove"]],
      ["broken.tar", "broken.tar", "status-text bad", "bad tar", detail, ["Remove"]],
      ["unsure.tar", "unsure.tar", "status-text bad", "The import may or may not have finished. Check the character list before trying again.", detail, ["Remove"]],
    ]);
    expect(view.host.querySelector(".archive-list .settings-empty")).toBeNull();
    expect(view.host.querySelector(".archive .setting-label")?.className).toBe("setting-label mono");
  });

  test("exports the chosen character, then lists it again at once", async () => {
    const toasts = await toastSpy();
    const net = transfers((path) => path === "/export" ? Response.json(archive("bo-export", { phase: "exporting" })) : Response.json(list([])));
    const view = await page({ character: null });
    const select = view.host.querySelector<HTMLSelectElement>("select[aria-label='Character to export']");
    expect([options(select), select?.value, button(view.host, "Export and download").disabled]).toEqual([[["", "Choose a character"], ["ada", "ada"], ["bo", "bo"]], "", true]);
    await type(select, "bo");
    const before = net.sent.length;
    await click(button(view.host, "Export and download"));
    await settle();
    const exported = net.sent[before];
    expect([exported?.path, exported?.init.method, exported?.init.credentials, exported?.init.body, new Headers(exported?.init.headers).get("content-type"), net.paths().slice(before)]).toEqual(["/export", "POST", "same-origin", JSON.stringify({ character: "bo" }), "application/json", ["/export", "/list"]]);
    expect(toasts()).toEqual([]);
    const chosen = await page();
    expect(chosen.host.querySelector<HTMLSelectElement>("select[aria-label='Character to export']")?.value).toBe("ada");
  });

  test("a transfer that fails says why, or that it failed", async () => {
    const toasts = await toastSpy();
    const answers = [
      Response.json({ message: "disk full" }, { status: 507 }), new Response("not json", { status: 500 }), Response.json(null, { status: 500 }), Response.json("oops", { status: 500 }),
      Response.json({}, { status: 500 }), Response.json({ message: 5 }, { status: 500 }), Response.json({ id: "x" }),
    ];
    transfers((path) => path === "/export" ? answers.shift() ?? Response.json(list([])) : Response.json(list([])));
    const view = await page();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await click(button(view.host, "Export and download"));
      await settle();
    }
    const failed = "The archive transfer failed";
    expect(toasts()).toEqual([["disk full", "error"], ...[1, 2, 3, 4, 5].map(() => [failed, "error"]), ["The daemon sent an unexpected archive response. Reload the page.", "error"]]);
  });

  test("transfers give up after a minute unless they carry their own signal", async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    app.restores.push(() => { timeout.mockRestore(); });
    const net = transfers(() => Response.json(list([])));
    const view = await page();
    await click(button(view.host, "Export and download"));
    await settle();
    const input = view.host.querySelector<HTMLInputElement>("input[type=file]");
    const picked = new DataTransfer();
    picked.items.add(new File([new Uint8Array(3)], "x.tar"));
    if (input === null) throw new Error("no file input");
    input.files = picked.files;
    await acting(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    const timed = timeout.mock.results.map((result) => result.value as AbortSignal);
    expect(timeout.mock.calls.every(([ms]) => ms === 60_000)).toBe(true);
    expect(net.sent.map((item) => [item.path, timed.includes(item.init.signal as AbortSignal)])).toEqual([["/list", true], ["/export", true], ["", false], ["/list", true]]);
  });

  test("uploads an archive no larger than the limit, and can stop an upload", async () => {
    const toasts = await toastSpy();
    let uploading: Route = () => HOLD;
    const net = transfers((path, init) => path === "" ? uploading(path, init) : Response.json(list([])));
    const early = await page();
    const choose = async (root: ParentNode, name: string, bytes: number) => {
      const input = root.querySelector<HTMLInputElement>("input[type=file]");
      if (input === null) throw new Error("no file input");
      const picked = new DataTransfer();
      picked.items.add(new File([new Uint8Array(bytes)], name));
      input.files = picked.files;
      await acting(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
      await settle();
      return input;
    };
    const input = await choose(early.host, "my archive.tar", 3);
    expect([input.files?.length, input.value, input.accept]).toEqual([0, "", ".tar,.tar.gz,.tgz,application/x-tar,application/gzip"]);
    const upload = net.sent.find((item) => item.path === "");
    const headers = new Headers(upload?.init.headers);
    expect([upload?.init.method, (upload?.init.body as File | undefined)?.name, headers.get("content-type"), headers.get("x-shore-filename")]).toEqual(["POST", "my archive.tar", "application/octet-stream", "my%20archive.tar"]);
    expect([button(early.host, "Stop upload").textContent, input.disabled, button(early.host, "Export and download").disabled]).toEqual(["Stop upload", true, true]);
    await click(button(early.host, "Stop upload"));
    await settle();
    expect([early.host.querySelector(".file-button + button"), toasts()]).toEqual([null, [["The upload was stopped.", "error"]]]);
    uploading = () => Response.json(archive("mine", { phase: "uploading" }));
    const before = net.sent.length;
    await choose(early.host, "fits.tar", 100 * MIB);
    expect(net.paths().slice(before)).toEqual(["", "/list"]);
    await choose(early.host, "huge.tar", 100 * MIB + 1);
    expect(net.paths().slice(before)).toEqual(["", "/list"]);
    expect(toasts().slice(1)).toEqual([["Uploaded. Import it from the list below.", "info"], [`Choose an archive no larger than ${size(100 * MIB)}`, "error"]]);
    net.serve((path) => path === "/list" ? HOLD : Response.json(archive("mine", { phase: "uploading" })));
    const unlisted = await page();
    await choose(unlisted.host, "huge.tar", 100 * MIB + 1);
    expect(net.paths().at(-2)).toBe("");
  });

  test("downloads a ready archive only when it arrives whole, and lets go of it after a second", async () => {
    const toasts = await toastSpy();
    const made = spyOn(URL, "createObjectURL").mockReturnValue("blob:archive");
    const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const saved: string[][] = [];
    const clicks = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push([this.href, this.download]); });
    app.restores.push(() => { made.mockRestore(); revoked.mockRestore(); clicks.mockRestore(); });
    const net = transfers((path) => path === "/whole/download" ? new Response(new Uint8Array(4)) : path === "/short/download" ? new Response(new Uint8Array(3)) : Response.json(list([archive("whole", { bytes: 4 }), archive("short", { bytes: 4 })])));
    const view = await page();
    jest.useFakeTimers();
    const [whole, short] = [...view.host.querySelectorAll(".archive")].map((item) => button(item, "Download"));
    await click(whole);
    await drain();
    expect([saved, toasts(), net.paths().slice(-2)]).toEqual([[["blob:archive", "whole.tar"]], [["Downloaded whole.tar", "info"]], ["/whole/download", "/list"]]);
    const blob = made.mock.calls[0]?.[0] as Blob;
    expect(await blob.arrayBuffer()).toEqual(new Uint8Array(4).buffer);
    await acting(() => { jest.advanceTimersByTime(999); });
    expect(revoked).not.toHaveBeenCalled();
    await acting(() => { jest.advanceTimersByTime(1); });
    expect(revoked.mock.calls).toEqual([["blob:archive"]]);
    await click(short);
    await drain();
    expect([saved.length, toasts().at(-1), net.paths().at(-1)]).toEqual([1, ["The download was incomplete. Prepare the export again.", "error"], "/short/download"]);
  });

  test("imports an uploaded archive once confirmed, and removes transfers", async () => {
    const net = transfers((path) => path.endsWith("/import") ? Response.json(archive("up", { downloadable: false, phase: "importing" })) : path.endsWith("/remove") ? Response.json({}) : Response.json(list([archive("up", { downloadable: false })])));
    const view = await page();
    await click(button(view.host, "Import…"));
    const dialog = () => view.host.querySelector("dialog");
    expect([dialog()?.querySelector("h2")?.textContent, dialog()?.querySelector(".form-text")?.textContent]).toEqual(["Import up.tar?", "Existing characters are kept. If a character with the same name exists, the import is rejected."]);
    await click(button(dialog() ?? view.host, "Cancel"));
    expect([dialog(), net.paths().filter((path) => path !== "/list")]).toEqual([null, []]);
    await click(button(view.host, "Import…"));
    const before = app.socket().sent.length;
    await click(button(dialog() ?? view.host, "Import"));
    expect(dialog()).toBeNull();
    await settle();
    expect(net.paths().filter((path) => path !== "/list")).toEqual(["/up/import"]);
    expect(net.paths().at(-1)).toBe("/list");
    expect(app.sent(before).map((request) => String(request["name"])).sort((a, b) => a.localeCompare(b))).toEqual(["discover_operations", "list_characters", "list_threads"]);
    await click(button(view.host, "Remove"));
    await settle();
    expect(net.paths().slice(-2)).toEqual(["/up/remove", "/list"]);
  });

  test("exports to and imports from paths on the daemon's machine", async () => {
    const toasts = await toastSpy();
    transfers(() => Response.json(list([])));
    app.answer((request) => {
      if (request["name"] === "export_character") return { character: "ada", archive: "/archives/ada.tar", bytes: 10, live: true, call_diagnostics: "kept", external_memory: "none" };
      if (request["name"] === "import_character") return { character: "bo", archive: "/a.tar", imported: true, external_memory: "none" };
      return undefined;
    });
    const view = await page();
    const who = view.host.querySelector<HTMLSelectElement>("select[aria-label='Character to export to a path']");
    const output = view.host.querySelector("input[aria-label='Export path']");
    const archivePath = view.host.querySelector("input[aria-label='Archive path to import']");
    expect([options(who), who?.value, button(view.host, "Export to path").disabled, button(view.host, "Import from path").disabled]).toEqual([[["ada", "ada"], ["bo", "bo"]], "ada", true, true]);
    await type(output, "   ");
    await type(archivePath, "  ");
    expect([button(view.host, "Export to path").disabled, button(view.host, "Import from path").disabled]).toEqual([true, true]);
    await type(output, " /tmp/out ");
    await type(who, "bo");
    const before = app.socket().sent.length;
    const submit = async (field: Element | null) => {
      const event = new Event("submit", { bubbles: true, cancelable: true });
      await acting(() => { field?.closest("form")?.dispatchEvent(event); });
      await settle();
      return event.defaultPrevented;
    };
    const kept = [await submit(output)];
    await type(archivePath, " /a.tar ");
    kept.push(await submit(archivePath));
    expect(kept, "the page stays put").toEqual([true, true]);
    const commands = app.sent(before).filter((request) => request["name"] === "export_character" || request["name"] === "import_character").map((request) => [request["name"], request["args"]]);
    expect(commands).toEqual([["export_character", { character: "bo", output: "/tmp/out" }], ["import_character", { archive: "/a.tar" }]]);
    expect(app.sent(before).map((request) => request["name"])).toContain("list_characters");
    expect(toasts()).toEqual([["Exported bo to /archives/ada.tar", "info"], ["Imported bo", "info"]]);
    const nobody = await page({ character: null });
    await type(nobody.host.querySelector("input[aria-label='Export path']"), "/tmp/out");
    expect(button(nobody.host, "Export to path").disabled, "no character is chosen yet").toBe(true);
  });
});
