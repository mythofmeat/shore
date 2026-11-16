import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/loader.ts";

function warned(toml: string): unknown[] {
  const root = mkdtempSync(join(tmpdir(), "shore-mcp-config-"));
  const path = join(root, "config.toml");
  writeFileSync(path, toml);
  const said: unknown[] = [];
  loadConfig(path, { env: { SHORE_CONFIG_DIR: root }, onWarn: (message, fields) => { said.push([message, fields]); } });
  return said;
}

test("an MCP server has one transport, and headers and a bearer token only go with a URL", () => {
  expect(() => warned('[mcp.both]\ncommand = "srch"\nurl = "http://127.0.0.1:1/mcp"\n')).toThrow("mcp.both sets both `command` and `url`; set exactly one transport");
  expect(() => warned('[mcp.neither]\nargs = ["x"]\n')).toThrow("mcp.neither sets neither `command` nor `url`; set exactly one transport");
  expect(() => warned('[mcp.local]\ncommand = "srch"\n[mcp.local.headers]\nX-Team = "lamp"\n')).toThrow("mcp.local sets `headers` on a `command` server; headers are HTTP-only");
  expect(() => warned('[mcp.local]\ncommand = "srch"\nbearer_token_env = "SRCH_TOKEN"\n')).toThrow("mcp.local sets `bearer_token_env` on a `command` server; it is HTTP-only");
  expect(() => warned('[mcp.remote]\nurl = "http://127.0.0.1:1/mcp"\nbearer_token_env = "SRCH_TOKEN"\n[mcp.remote.headers]\nAUTHORIZATION = "Bearer x"\n')).toThrow(
    "mcp.remote sets both `bearer_token_env` and an Authorization header; set one",
  );
  expect(warned('[mcp.remote]\nurl = "http://127.0.0.1:1/mcp"\nbearer_token_env = "SRCH_TOKEN"\n[mcp.remote.headers]\nX-Team = "lamp"\n\n[mcp.local]\ncommand = "srch"\n')).toEqual([]);
});

test("tools.mcp names servers one at a time, and a grant for a server with no definition is said to match nothing", () => {
  const none = "tools.mcp names MCP servers one at a time; an empty or `*` entry matches no tools";
  expect(warned('[tools]\nenabled = ["read", "mcp__search__find", "mcp__missing__find"]\nmcp = ["", "*", "search", "gone"]\n\n[mcp.search]\ncommand = "srch"\n')).toEqual([
    [none, [["server", ""]]],
    [none, [["server", "*"]]],
    ["tool grant references MCP server with no [mcp.missing] definition; it will match no tools", [["pattern", "mcp__missing__find"], ["server", "missing"]]],
    ["tool grant references MCP server with no [mcp.gone] definition; it will match no tools", [["pattern", "mcp__gone__*"], ["server", "gone"]]],
  ]);
  expect(warned('[tools]\nenabled = ["read", "mcp__search__find"]\nmcp = ["search"]\n\n[mcp.search]\ncommand = "srch"\n')).toEqual([]);
});
