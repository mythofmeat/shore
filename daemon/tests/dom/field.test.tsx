import { afterEach, describe, expect, test } from "bun:test";

import type { Control } from "../../src/browser/forms.ts";
import { button, click, mount, type, useDom } from "./dom.ts";

useDom();

afterEach(() => { document.body.replaceChildren(); });

async function field(control: Control, value: unknown, secret?: boolean) {
  const { Field } = await import("../../src/browser/ui/Field.tsx");
  const changes: unknown[] = [];
  const props = secret === undefined ? {} : { secret };
  const view = await mount(<Field control={control} value={value} change={(next) => { changes.push(next); }} label="Thing" id="thing" {...props} />);
  return { ...view, changes };
}

describe("a text field", () => {
  test("edits free text, hidden when secret, and shows anything that is not text as empty", async () => {
    const plain = await field({ kind: "string" }, "hello");
    const input = plain.host.querySelector("input");
    expect([input?.id, input?.className, input?.type, input?.getAttribute("aria-label"), input?.getAttribute("autocomplete"), input?.value]).toEqual(["thing", "input", "text", "Thing", "off", "hello"]);
    await type(input, "hello!");
    expect(plain.changes).toEqual(["hello!"]);
    expect((await field({ kind: "string" }, 5, true)).host.querySelector("input")?.type).toBe("password");
    expect((await field({ kind: "string" }, 5, false)).host.querySelector("input")?.value).toBe("");
  });

  test("offers choices, keeping a value that is not one of them, and edits long text in a box", async () => {
    const chosen = await field({ kind: "string", choices: ["a", "b"] }, "a");
    const select = chosen.host.querySelector("select");
    expect([select?.id, select?.className, select?.getAttribute("aria-label"), [...(select?.options ?? [])].map((option) => option.value)]).toEqual(["thing", "select", "Thing", ["a", "b"]]);
    await type(select, "b");
    expect(chosen.changes).toEqual(["b"]);
    expect([...((await field({ kind: "string", choices: ["a"] }, "z")).host.querySelector("select")?.options ?? [])].map((option) => [option.value, option.textContent])).toEqual([["z", "z"], ["a", "a"]]);
    expect([...((await field({ kind: "string", choices: ["a"] }, undefined)).host.querySelector("select")?.options ?? [])].map((option) => option.textContent)).toEqual(["Choose…", "a"]);
    const long = await field({ kind: "string", multiline: true }, "line");
    const box = long.host.querySelector("textarea");
    expect([box?.id, box?.className, box?.getAttribute("rows"), box?.value, box?.getAttribute("aria-label")]).toEqual(["thing", "input textarea", "3", "line", "Thing"]);
    await type(box, "lines");
    expect(long.changes).toEqual(["lines"]);
  });
});

describe("a number field", () => {
  test("passes on only finite numbers, whole ones for an integer, and nothing for a blank", async () => {
    const whole = await field({ kind: "integer", minimum: 1, maximum: 9 }, 3);
    const input = whole.host.querySelector("input");
    expect([input?.id, input?.className, input?.inputMode, input?.value, input?.getAttribute("min"), input?.getAttribute("max"), input?.getAttribute("aria-label")]).toEqual(["thing", "input compact", "numeric", "3", "1", "9", "Thing"]);
    for (const text of ["12", "1.5", "abc", "Infinity", "  ", " 7 "]) await type(input, text);
    expect(whole.changes).toEqual([12, undefined, 7]);
    expect(input?.value, "the text typed stays as typed").toBe(" 7 ");
    const decimal = await field({ kind: "number" }, "not a number");
    const box = decimal.host.querySelector("input");
    expect([box?.inputMode, box?.value, box?.hasAttribute("min")]).toEqual(["decimal", "", false]);
    await type(box, "1.5");
    expect(decimal.changes).toEqual([1.5]);
  });
});

describe("other single fields", () => {
  test("a yes-or-no switch, and a field with no value", async () => {
    const yes = await field({ kind: "boolean" }, true);
    const toggle = yes.host.querySelector("[role=switch]");
    expect([toggle?.getAttribute("aria-checked"), toggle?.getAttribute("aria-label")]).toEqual(["true", "Thing"]);
    await click(toggle);
    expect(yes.changes).toEqual([false]);
    expect((await field({ kind: "boolean" }, "true")).host.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("false");
    const nothing = await field({ kind: "null" }, null);
    expect([nothing.host.querySelector(".muted")?.textContent, nothing.host.querySelector("input")]).toEqual(["No value", null]);
  });

  test("JSON is edited as text, passed on once it parses, and flagged until then", async () => {
    const json = await field({ kind: "json" }, { a: 1 });
    const box = json.host.querySelector("textarea");
    expect([box?.id, box?.className, box?.getAttribute("rows"), box?.value, box?.getAttribute("aria-label")]).toEqual(["thing", "input textarea mono", "4", '{\n  "a": 1\n}', "Thing"]);
    await type(box, "{");
    expect(json.host.querySelector(".form-error")?.textContent).toBe("Enter valid JSON");
    await type(box, "[1]");
    expect(json.host.querySelector(".form-error")).toBeNull();
    await type(box, "{");
    await type(box, "  ");
    expect([json.host.querySelector(".form-error"), json.changes]).toEqual([null, [[1], undefined]]);
    expect((await field({ kind: "json" }, "raw text")).host.querySelector("textarea")?.value).toBe("raw text");
    expect((await field({ kind: "json" }, "")).host.querySelector("textarea")?.value).toBe("");
    expect((await field({ kind: "json" }, undefined)).host.querySelector("textarea")?.value).toBe("");
  });
});

describe("a list field", () => {
  test("edits, removes and adds items, each labelled by its place", async () => {
    const list = await field({ kind: "array", item: { kind: "string" } }, ["a", "b"]);
    const inputs = [...list.host.querySelectorAll("input")];
    expect(inputs.map((input) => [input.id, input.getAttribute("aria-label"), input.value])).toEqual([["thing-0", "Thing 1", "a"], ["thing-1", "Thing 2", "b"]]);
    await type(inputs[1], "c");
    await click(button(list.host, "Remove Thing 1"));
    await click(button(list.host, "Add another"));
    expect(list.changes).toEqual([["a", "c"], ["b"], ["a", "b", ""]]);
    const empty = await field({ kind: "array", item: { kind: "integer", minimum: 2 } }, "not a list");
    expect(empty.host.querySelectorAll("input")).toHaveLength(0);
    await click(button(empty.host, "Add an item"));
    expect(empty.changes).toEqual([[2]]);
  });
});

describe("a group field", () => {
  const group: Control = { kind: "object", fields: { name: { kind: "string" }, note: { kind: "string", multiline: true }, size: { kind: "integer" } }, required: ["name"], hints: { name: "What to call it", note: "" } };

  test("lays out each field with its label, whether it is optional, and its hint", async () => {
    const view = await field(group, { name: "x" });
    const rows = [...view.host.querySelectorAll(".field-row")];
    expect(rows.map((row) => [row.className, row.querySelector("label")?.textContent, row.querySelector(".field-hint")?.textContent ?? null, row.querySelector("label")?.htmlFor])).toEqual([
      ["field-row ", "Name", "What to call it", "thing-name"],
      ["field-row block", "Note (optional)", null, "thing-note"],
      ["field-row ", "Size (optional)", null, "thing-size"],
    ]);
    expect(view.host.querySelector<HTMLInputElement>("#thing-name")?.value).toBe("x");
  });

  test("drops an emptied optional field, keeps an emptied required one, and treats anything else as an empty group", async () => {
    const view = await field(group, { name: "x", note: "n", size: 3 });
    await type(view.host.querySelector("#thing-note"), "");
    await type(view.host.querySelector("#thing-name"), "");
    await type(view.host.querySelector("#thing-size"), " ");
    await type(view.host.querySelector("#thing-name"), "y");
    expect(view.changes).toEqual([{ name: "x", size: 3 }, { name: "", note: "n", size: 3 }, { name: "x", note: "n" }, { name: "y", note: "n", size: 3 }]);
    for (const value of [null, ["x"], "x"]) {
      const odd = await field(group, value);
      await type(odd.host.querySelector("#thing-name"), "z");
      expect(odd.changes, String(value)).toEqual([{ name: "z" }]);
    }
  });

  test("lists extra entries, which can be removed, edited and added under a new unused name", async () => {
    const open: Control = { kind: "object", fields: {}, required: [], additional: { kind: "string" } };
    const view = await field(open, { kept: "k", other: "o" });
    expect([...view.host.querySelectorAll(".field-label")].map((label) => label.textContent)).toEqual(["Kept (optional)", "Other (optional)"]);
    await type(view.host.querySelector("#thing-extra-kept"), "k2");
    await click(button(view.host, "Remove other"));
    const name = view.host.querySelector<HTMLInputElement>("input[aria-label='New entry name']");
    const add = button(view.host, "Add entry");
    expect([name?.placeholder, add.disabled]).toEqual(["Entry name", true]);
    await type(name, "kept");
    expect(add.disabled, "a name already used").toBe(true);
    await type(name, "  fresh ");
    expect(add.disabled).toBe(false);
    await click(add);
    expect(name?.value).toBe("");
    expect(view.changes).toEqual([{ kept: "k2", other: "o" }, { kept: "k" }, { kept: "k", other: "o", fresh: "" }]);
  });

  test("leaves extra JSON entries to the group's own fields, but offers them when it has none", async () => {
    const withFields = await field({ kind: "object", fields: { a: { kind: "string" } }, required: [], additional: { kind: "json" } }, { a: "x", b: 1 });
    expect(withFields.host.querySelector("input[aria-label='New entry name']")).toBeNull();
    const without = await field({ kind: "object", fields: {}, required: [], additional: { kind: "json" } }, { b: 1 });
    expect(without.host.querySelector("input[aria-label='New entry name']")).not.toBeNull();
    const closed = await field({ kind: "object", fields: {}, required: [] }, { b: 1 });
    expect(closed.host.querySelector("input[aria-label='New entry name']")).toBeNull();
  });
});

describe("a field of several kinds", () => {
  test("picks the kind the value is, switches kind clearing the value, and names every kind", async () => {
    const all: Control[] = [{ kind: "string" }, { kind: "string", choices: ["a"] }, { kind: "integer" }, { kind: "number" }, { kind: "boolean" }, { kind: "null" }, { kind: "array", item: { kind: "string" } }, { kind: "object", fields: {}, required: [] }, { kind: "json" }, { kind: "union", options: [] }];
    const view = await field({ kind: "union", options: all }, 4);
    const group = view.host.querySelector("[role=radiogroup]");
    expect(group?.getAttribute("aria-label")).toBe("Thing type");
    const radios = [...view.host.querySelectorAll("[role=radio]")];
    expect(radios.map((radio) => radio.textContent)).toEqual(["Text", "Choice", "Whole number", "Number", "Yes or no", "Nothing", "List", "Group", "JSON", "Other"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false", "false", "false", "false", "false", "false", "false"]);
    expect(view.host.querySelector("input")?.value).toBe("4");
    await click(radios[5]);
    await click(radios[0]);
    expect(view.changes).toEqual([null, undefined]);
    expect([...view.host.querySelectorAll("[role=radio]")].map((radio) => radio.getAttribute("aria-checked"))[0]).toBe("true");
    expect(view.host.querySelector("input")?.value, "4 is not text, so the text field starts empty").toBe("");
  });

  test("starts on its first kind when the value fits none, shows no switch for one kind, and nothing for none", async () => {
    const unfit = await field({ kind: "union", options: [{ kind: "string" }, { kind: "boolean" }] }, undefined);
    expect([...unfit.host.querySelectorAll("[role=radio]")].map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    const unset = await field({ kind: "union", options: [{ kind: "string" }, { kind: "json" }] }, undefined);
    expect([...unset.host.querySelectorAll("[role=radio]")].map((radio) => radio.getAttribute("aria-checked")), "JSON takes anything, but not an unset value").toEqual(["true", "false"]);
    const single = await field({ kind: "union", options: [{ kind: "boolean" }] }, true);
    expect([single.host.querySelector("[role=radiogroup]"), single.host.querySelector("[role=switch]")?.getAttribute("aria-checked")]).toEqual([null, "true"]);
    const none = await field({ kind: "union", options: [] }, 1);
    expect(none.host.innerHTML).toBe("");
  });

  test("lays out wide kinds as blocks in a group", async () => {
    const view = await field({ kind: "object", fields: { list: { kind: "array", item: { kind: "string" } }, either: { kind: "union", options: [{ kind: "string" }] }, raw: { kind: "json" }, child: { kind: "object", fields: {}, required: [] }, flag: { kind: "boolean" } }, required: [] }, {});
    expect([...view.host.querySelectorAll(":scope > .field-object > .field-row")].map((row) => row.className)).toEqual(["field-row block", "field-row block", "field-row block", "field-row block", "field-row "]);
  });
});
