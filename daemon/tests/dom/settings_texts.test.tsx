import { describe, expect, test } from "bun:test";

import { useApp } from "./app.ts";
import { acting, button, click, mount } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };

const entry = (name: string, owner: string, extra: Record<string, unknown> = {}) => ({
  name, place: `Where ${name} goes.`, owner, required: false, wording: `${name} wording`, shipped: `${name} wording`, file: null, error: null, values: [], changed: false, previous: null, ...extra,
});

const TEXTS = [
  entry("time", "yours", { wording: "[now: {{now}}]", shipped: "[{{now}}]", file: "/config/texts/time.md", values: [{ name: "now", about: "the time" }] }),
  entry("status", "off", { wording: null }),
  entry("opened_by_you", "shore", { required: true }),
  entry("label", "yours", { required: true, wording: null, shipped: "Label this.", file: "/config/gone.md", error: "text \"label\" could not be read at /config/gone.md" }),
  entry("cli_identity", "cli"),
];

async function page(character: string | null, answer: (args: unknown) => unknown = () => ({ texts: TEXTS })) {
  app.answer((request) => request["name"] === "texts" ? answer(request["args"]) : undefined);
  const { TextsPage } = await import("../../src/browser/settings/Texts.tsx");
  const view = await mount(<TextsPage state={{ ...app.state().workspace.getSnapshot(), character }} />);
  await settle();
  return view;
}

function rows(root: ParentNode): [summary: string, facts: [string, string][]][] {
  return [...root.querySelectorAll("details")].map((details) => [
    details.querySelector("summary")?.textContent ?? "",
    [...details.querySelectorAll(".kv-row")].map((row) => [row.querySelector("dt")?.textContent ?? "", row.querySelector("dd")?.textContent ?? ""]),
  ]);
}

describe("the texts page", () => {
  test("lists every text with whose wording is in use, where it goes, the values it is given, and Shore's wording beside one that differs", async () => {
    const before = app.socket().sent.length;
    const view = await page("ada");
    expect(view.host.querySelector(".settings-description")?.textContent).toBe("Everything Shore writes for ada’s model besides your messages and files: what each text is, where it goes and whose wording is in use. Under [texts] in config.toml, point a name at a file of your own, or set it to false to switch it off.");
    expect(app.sent(before).filter((request) => request["name"] === "texts").map((request) => request["args"])).toEqual([{}]);
    expect(rows(view.host)).toEqual([
      ["time · Your wording", [["Where", "Where time goes."], ["File", "/config/texts/time.md"], ["{{now}}", "the time"], ["In use", "[now: {{now}}]"], ["Shore’s", "[{{now}}]"]]],
      ["status · Switched off", [["Where", "Where status goes."], ["In use", "(none)"], ["Shore’s", "status wording"]]],
      ["opened_by_you · Shore’s wording", [["Where", "Where opened_by_you goes. It can’t be switched off."], ["In use", "opened_by_you wording"]]],
      ["label · Your wording", [["Where", "Where label goes. It can’t be switched off."], ["File", "/config/gone.md"], ["Error", "text \"label\" could not be read at /config/gone.md"], ["In use", "(none)"], ["Shore’s", "Label this."]]],
      ["cli_identity · The CLI’s wording", [["Where", "Where cli_identity goes."], ["In use", "cli_identity wording"]]],
    ]);
    expect(view.host.querySelector("[role=alert]")?.textContent).toBe("text \"label\" could not be read at /config/gone.md");
  });

  test("without a character it speaks of a character's model, and a list that can't be read says why", async () => {
    const none = await page(null);
    expect(none.host.querySelector(".settings-description")?.textContent).toStartWith("Everything Shore writes for a character’s model besides");
    const failed = await page("ada", () => { throw new Error("the list could not be made"); });
    expect(failed.host.querySelector(".form-error")?.textContent).toContain("the list could not be made");
    expect(rows(failed.host)).toEqual([]);
  });

  test("a text an update reworded or added is marked, with Shore's wording before, until the user marks them seen", async () => {
    const changed = [
      entry("wake", "shore", { changed: true, previous: "Wake up.", wording: "Wake, please.", shipped: "Wake, please." }),
      entry("wake_turn", "shore", { changed: true }),
      entry("time", "yours"),
    ];
    let marked = false;
    const view = await page("ada", () => ({ texts: marked ? changed.map((text) => ({ ...text, changed: false, previous: null })) : changed }));
    app.answer((request) => {
      if (request["name"] === "texts_seen") { marked = true; return { texts: [] }; }
      return request["name"] === "texts" ? { texts: marked ? changed.map((text) => ({ ...text, changed: false, previous: null })) : changed } : undefined;
    });
    expect(rows(view.host).map(([summary]) => summary)).toEqual(["wake · Shore’s wording · changed in an update", "wake_turn · Shore’s wording · new in an update", "time · Your wording"]);
    expect(rows(view.host)[0]?.[1]).toEqual([["Where", "Where wake goes."], ["In use", "Wake, please."], ["Shore’s before", "Wake up."]]);
    expect(view.host.textContent).toContain("2 of Shore’s texts in use are new or reworded since you last marked them seen.");
    const before = app.socket().sent.length;
    await click(button(view.host, "Mark as seen"));
    await settle();
    expect(app.sent(before).map((request) => request["name"])).toEqual(["texts_seen", "texts"]);
    expect(rows(view.host).map(([summary]) => summary)).toEqual(["wake · Shore’s wording", "wake_turn · Shore’s wording", "time · Your wording"]);
    expect([...view.host.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("Mark as seen");
  });

  test("one changed text is counted as one", async () => {
    const view = await page("ada", () => ({ texts: [entry("wake", "shore", { changed: true, previous: "Wake up." })] }));
    expect(view.host.textContent).toContain("1 of Shore’s texts in use is new or reworded since you last marked them seen.");
  });
});
