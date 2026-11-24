import { describe, expect, test } from "bun:test";

import { useApp } from "./app.ts";
import { acting, mount } from "./dom.ts";

const app = useApp();

const settle = async () => { await acting(() => Bun.sleep(5)); };

const entry = (name: string, owner: string, extra: Record<string, unknown> = {}) => ({
  name, place: `Where ${name} goes.`, owner, required: false, wording: `${name} wording`, shipped: `${name} wording`, file: null, error: null, values: [], ...extra,
});

const TEXTS = [
  entry("time", "yours", { wording: "[now: {{now}}]", shipped: "[{{now}}]", file: "/config/texts/time.md", values: [{ name: "now", about: "the time" }] }),
  entry("status", "off", { wording: null }),
  entry("opened_by_you", "shore", { required: true }),
  entry("label", "yours", { required: true, wording: null, shipped: "Label this.", file: "/config/gone.md", error: "text \"label\" could not be read at /config/gone.md" }),
  entry("line_cut", "fixed"),
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
      ["line_cut · Shore’s wording, which can’t be replaced yet", [["Where", "Where line_cut goes."], ["In use", "line_cut wording"]]],
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
});
