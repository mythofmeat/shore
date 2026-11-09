import { describe, expect, test } from "bun:test";

import {
  appendTomlArrayTable,
  removeTomlArrayTable,
  removeTomlTable,
  reorderTomlArrayTables,
  setTomlArrayTableValue,
  setTomlValue,
  TomlEditError,
  tomlArrayTableCount,
  tomlDefinesTable,
  tomlKeyDefined,
  unsetTomlArrayTableValue,
  unsetTomlValue,
} from "../src/config/toml_edit.ts";

function refusal(edit: () => unknown): TomlEditError {
  try {
    edit();
  } catch (error) {
    if (error instanceof TomlEditError) return error;
    throw error;
  }
  throw new Error("the edit was not refused");
}

describe("reading keys the way TOML writes them", () => {
  test("bare, quoted, escaped, literal and dotted keys with spaces all name the same paths", () => {
    const source = [
      'plain = 1',
      '"with space" = 2',
      '"tab\\there\\nnewline\\"quote\\\\" = 3',
      "'C:\\dir' = 4",
      'a . b . "c d" = 5',
      '  indented.key = 6',
      '"" = 7',
    ].join("\n");
    for (const path of [["plain"], ["with space"], ['tab\there\nnewline"quote\\'], ["C:\\dir"], ["a", "b", "c d"], ["indented", "key"], [""]]) {
      expect(tomlKeyDefined(source, path)).toBe(true);
    }
    expect(tomlKeyDefined(source, ["a", "b"])).toBe(false);
    expect(tomlKeyDefined(source, ["missing"])).toBe(false);
  });

  test("lines that are not assignments are skipped: blanks, comments, a key with no value, a value with no key and unterminated quotes", () => {
    const source = ["", "   ", "# comment = 1", "  # indented = 2", "orphan", "= 3", '"open = 4', "'open = 5", "x.y. = 6", "z = 7"].join("\n");
    expect(tomlKeyDefined(source, ["z"])).toBe(true);
    for (const path of [["comment"], ["indented"], ["orphan"], [""], ["open"], ['open = 4'], ["x", "y"]]) {
      expect(tomlKeyDefined(source, path)).toBe(false);
    }
  });

  test("headers set the table for the lines that follow, and malformed headers are ignored", () => {
    const source = ["top = 1", "[ a . b ]", "x = 1", "[[list]]", "y = 2", "[[broken]", "z = 3", "[!]", "w = 4", "[]", "v = 5"].join("\n");
    expect(tomlKeyDefined(source, ["top"])).toBe(true);
    expect(tomlKeyDefined(source, ["a", "b", "x"])).toBe(true);
    expect(tomlKeyDefined(source, ["list", "y"])).toBe(true);
    for (const path of [["list", "z"], ["list", "w"], ["list", "v"]]) expect(tomlKeyDefined(source, path)).toBe(true);
    expect(tomlArrayTableCount(source, ["broken"])).toBe(0);
    expect(tomlArrayTableCount(source, ["list"])).toBe(1);
  });

  test("a value runs until its brackets close and its multi-line strings end, ignoring brackets, quotes and hashes inside strings", () => {
    const values = [
      'a = [\n  1,\n  [2, 3],\n]',
      'a = { b = [1, 2], c = { d = 3 } }',
      'a = """\nline [ with { brackets\n"""',
      "a = '''\nraw \\ ''' ",
      'a = """first""" # and """ in a comment',
      'a = """"""',
      'a = ["]", "[", "#", \'"\', "\\"]"]',
      'a = [ # a comment ]\n  1,\n]',
      'a = "unterminated [',
    ];
    for (const value of values) {
      const source = `${value}\nnext = 1\n`;
      expect(setTomlValue(source, ["a"], "0").text).toBe("a = 0\nnext = 1\n");
    }
  });
});

describe("setTomlValue", () => {
  test("replacing keeps the indentation and the key as it was written", () => {
    const source = '[t]\n  "quoted key" = 1\n  plain.dotted = [\n    2,\n  ]\nafter = 3\n';
    const quoted = setTomlValue(source, ["t", "quoted key"], "9");
    expect(quoted).toEqual({ text: '[t]\n  "quoted key" = 9\n  plain.dotted = [\n    2,\n  ]\nafter = 3\n', action: "replaced" });
    expect(setTomlValue(source, ["t", "plain", "dotted"], "[]").text).toBe('[t]\n  "quoted key" = 1\n  plain.dotted = []\nafter = 3\n');
  });

  test("a new key goes after the last value of its nearest table, even one written over several lines", () => {
    const source = "[a]\nx = 1\n\n[a.b]\nlist = [\n  1,\n]\n# trailing comment\n\n[c]\ny = 2\n";
    expect(setTomlValue(source, ["a", "b", "z"], "3")).toEqual({
      text: "[a]\nx = 1\n\n[a.b]\nlist = [\n  1,\n]\nz = 3\n# trailing comment\n\n[c]\ny = 2\n",
      action: "added-to-section",
    });
    expect(setTomlValue(source, ["a", "b", "deeper", "key"], '"v"').text).toBe(
      "[a]\nx = 1\n\n[a.b]\nlist = [\n  1,\n]\ndeeper.key = \"v\"\n# trailing comment\n\n[c]\ny = 2\n",
    );
    expect(setTomlValue("[empty]\n[next]\n", ["empty", "k"], "1").text).toBe("[empty]\nk = 1\n[next]\n");
    const intoArray = setTomlValue("[[t]]\nx = 1\n", ["t", "y"], "1");
    expect(intoArray.action).toBe("added-section");
    expect(intoArray.text.startsWith("[[t]]\nx = 1\n\n")).toBe(true);
  });

  test("a key with no table to go into starts one at the end, quoting what needs quoting", () => {
    expect(setTomlValue("", ["top"], "1")).toEqual({ text: "top = 1\n", action: "added-section" });
    expect(setTomlValue("", ["a", "b"], "1").text).toBe("[a]\nb = 1\n");
    expect(setTomlValue("   \n", ["a", "b"], "1").text).toBe("   \n[a]\nb = 1\n");
    expect(setTomlValue("x = 1", ["models", "chat.x", "my name"], '"n"').text).toBe('x = 1\n\n[models."chat.x"]\n"my name" = "n"\n');
    expect(setTomlValue("x = 1\n", ["y"], "2").text).toBe("x = 1\n\ny = 2\n");
  });

  test("a key inside a value written inline is refused with the line to edit by hand", () => {
    const source = "[d]\nok = 1\nbackground = { model = \"one\" }\n";
    const refused = refusal(() => setTomlValue(source, ["d", "background", "model"], '"two"'));
    expect(refused.message).toBe("`d.background.model` lives inside the value of `d.background` on line 3; edit that line by hand");
    expect(refused.name).toBe("TomlEditError");
    expect(refusal(() => unsetTomlValue(source, ["d", "background", "model"])).message).toBe(
      "`d.background.model` lives inside the value of `d.background` on line 3; edit that line by hand",
    );
  });

  test("an empty key is refused", () => {
    expect(refusal(() => setTomlValue("x = 1\n", [], "1")).message).toBe("empty config key");
    expect(refusal(() => unsetTomlValue("x = 1\n", [])).message).toBe("empty config key");
  });
});

describe("unsetTomlValue", () => {
  test("removes every line of the value and nothing else", () => {
    const source = "[t]\nkeep = 1\nlist = [\n  1,\n  2,\n]\nafter = 2\n";
    expect(unsetTomlValue(source, ["t", "list"])).toEqual({ text: "[t]\nkeep = 1\nafter = 2\n", removed: true });
  });

  test("a key that isn't there leaves the text as it was", () => {
    expect(unsetTomlValue("[t]\nkeep = 1\n", ["t", "gone"])).toEqual({ text: "[t]\nkeep = 1\n", removed: false });
  });
});

describe("tables", () => {
  test("a table counts as defined by its header, a sub-table, or a dotted key", () => {
    expect(tomlDefinesTable("[a.b]\n", ["a"])).toBe(true);
    expect(tomlDefinesTable("a.b = 1\n", ["a"])).toBe(true);
    expect(tomlDefinesTable("[x]\na = 1\n", ["a"])).toBe(false);
    expect(tomlDefinesTable("[x]\n", ["a"])).toBe(false);
  });

  test("removing a table takes its sub-tables, its leading comments, dotted keys and an inline parent, and closes the gap", () => {
    const source = [
      "keep = 1",
      "gone.dotted = 2",
      "",
      "# about gone",
      "[gone]",
      "x = 1",
      "",
      "[gone.sub]",
      "y = 2",
      "",
      "",
      "[stays]",
      "z = 3",
      "",
    ].join("\n");
    expect(removeTomlTable(source, ["gone"])).toBe("keep = 1\n\n[stays]\nz = 3\n");
    expect(removeTomlTable("[p]\ninline = { a = 1 }\nother = 2\n", ["p", "inline", "a"])).toBe("[p]\nother = 2\n");
    expect(removeTomlTable("# first line\n[gone]\nx = 1\n", ["gone"])).toBe("");
    expect(removeTomlTable("\n[gone]\nx = 1", ["gone"])).toBe("");
    expect(removeTomlTable("\n\n[gone]\nx = 1", ["gone"])).toBe("");
    expect(removeTomlTable("a = 1\n\n\n[gone]\nx = 1\n", ["gone"])).toBe("a = 1\n");
    expect(removeTomlTable("[gone]\nx = 1\n\n\nb = 2\n", ["gone"])).toBe("");
  });
});

describe("arrays of tables", () => {
  const providers = [
    "[defaults]",
    "model = \"m\"",
    "",
    "# the first",
    "[[providers]]",
    "name = \"one\"",
    "url = [",
    "  \"a\",",
    "]",
    "",
    "[[providers]]",
    "name = \"two\"",
    "",
    "[after]",
    "x = 1",
    "",
  ].join("\n");

  test("entries are counted and edited by position", () => {
    expect(tomlArrayTableCount(providers, ["providers"])).toBe(2);
    expect(setTomlArrayTableValue(providers, ["providers"], 1, "name", '"TWO"')).toBe(providers.replace('name = "two"', 'name = "TWO"'));
    expect(setTomlArrayTableValue(providers, ["providers"], 0, "url", "[]")).toBe(providers.replace('url = [\n  "a",\n]', "url = []"));
    expect(setTomlArrayTableValue(providers, ["providers"], 1, "my key", "1")).toBe(providers.replace('name = "two"\n', 'name = "two"\n"my key" = 1\n'));
    expect(unsetTomlArrayTableValue(providers, ["providers"], 0, "url")).toBe(providers.replace('url = [\n  "a",\n]\n', ""));
    expect(unsetTomlArrayTableValue(providers, ["providers"], 0, "missing")).toBe(providers);
    expect(unsetTomlArrayTableValue(providers, ["providers"], 1, "url")).toBe(providers);
    expect(refusal(() => setTomlArrayTableValue(providers, ["providers"], 2, "name", "1")).message).toBe("`providers` has no entry #3");
    expect(refusal(() => unsetTomlArrayTableValue(providers, ["defaults"], 0, "model")).message).toBe("`defaults` has no entry #1");
  });

  test("a new entry goes after the last one, or after its anchor table, or at the end", () => {
    expect(appendTomlArrayTable(providers, ["providers"], [["name", '"three"']])).toBe(providers.replace('name = "two"\n', 'name = "two"\n\n[[providers]]\nname = "three"\n'));
    const anchored = "[defaults]\nmodel = \"m\"\n\n[after]\nx = 1\n";
    expect(appendTomlArrayTable(anchored, ["providers"], [["name", '"one"'], ["the key", "1"]], ["defaults"])).toBe(
      '[defaults]\nmodel = "m"\n\n[[providers]]\nname = "one"\n"the key" = 1\n\n[after]\nx = 1\n',
    );
    expect(appendTomlArrayTable("[[defaults]]\nx = 1\n", ["providers"], [], ["defaults"])).toBe("[[defaults]]\nx = 1\n\n[[providers]]\n");
    expect(appendTomlArrayTable(anchored, ["providers"], [], ["missing"])).toBe(`${anchored}\n[[providers]]\n`);
    expect(appendTomlArrayTable("x = 1", ["providers"], [])).toBe("x = 1\n\n[[providers]]\n");
    expect(appendTomlArrayTable("", ["providers"], [["a", "1"]])).toBe("[[providers]]\na = 1\n");
    expect(appendTomlArrayTable(" \n", ["providers"], [])).toBe(" \n[[providers]]\n");
  });

  test("an array written inline can't take a new entry", () => {
    expect(refusal(() => appendTomlArrayTable("[d]\nx = 1\nproviders = []\n", ["d", "providers"], [])).message).toBe(
      "`d.providers` is written inline as `d.providers` on line 3; edit that line by hand",
    );
    expect(refusal(() => appendTomlArrayTable("d = { providers = [] }\n", ["d", "providers"], [])).message).toBe(
      "`d.providers` is written inline as `d` on line 1; edit that line by hand",
    );
    expect(appendTomlArrayTable("[d.providers.x]\ny = 1\n", ["d", "providers"], [])).toBe("[d.providers.x]\ny = 1\n\n[[d.providers]]\n");
  });

  test("removing an entry takes its leading comments and the blank line after it", () => {
    expect(removeTomlArrayTable(providers, ["providers"], 0)).toBe(providers.replace('# the first\n[[providers]]\nname = "one"\nurl = [\n  "a",\n]\n\n', ""));
    expect(removeTomlArrayTable(providers, ["providers"], 1)).toBe(providers.replace('[[providers]]\nname = "two"\n\n', ""));
    expect(removeTomlArrayTable("[[p]]\nx = 1\n\n", ["p"], 0)).toBe("");
  });

  test("entries can be reordered, keeping what sits between them, and a bad order is refused", () => {
    expect(reorderTomlArrayTables(providers, ["providers"], [1, 0])).toBe(
      [
        "[defaults]",
        "model = \"m\"",
        "",
        "[[providers]]",
        "name = \"two\"",
        "",
        "# the first",
        "[[providers]]",
        "name = \"one\"",
        "url = [",
        "  \"a\",",
        "]",
        "",
        "[after]",
        "x = 1",
        "",
      ].join("\n"),
    );
    expect(reorderTomlArrayTables(providers, ["providers"], [0, 1])).toBe(providers);
    for (const order of [[0], [0, 0], [0, 2], [1, 0, 2]]) {
      expect(refusal(() => reorderTomlArrayTables(providers, ["providers"], order)).message).toBe(
        "a new order for `providers` must name each of its 2 entries once",
      );
    }
  });
});
