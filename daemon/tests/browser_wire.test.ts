import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { browserValidators } from "../scripts/browser_validators.ts";
import { parseServerFrame } from "../src/browser/wire.ts";
import { SERVER_FIXTURES } from "./support/wire_fixtures.ts";

test("Rust and browser share structured image history without flattening or dropping data", () => {
  const history = SERVER_FIXTURES.history_with_image_tool_result;
  expect<unknown>(parseServerFrame(JSON.stringify(history))).toEqual({ kind: "known", message: history });
});

test("browser validators regenerate exactly from canonical Rust schemas", async () => {
  for (const [name, source] of Object.entries(browserValidators())) {
    expect(await readFile(new URL(`../src/browser/${name}`, import.meta.url), "utf8")).toBe(source);
  }
});

test("known malformed events cannot masquerade as forward-compatible events", () => {
  for (const value of [null, [], {}, { type: "" }, { type: 1 }, { type: "stream_chunk", content_type: "text", text: 7 }, { type: "history", messages: [], config: {}, revision: -1 }, { type: "history", messages: [], config: {}, revision: 9007199254740992 }, { type: "hello", v: 4294967296, server_name: "shore", characters: [] }, { type: "request_finished", rid: "r", outcome: "probably" }]) {
    expect(parseServerFrame(JSON.stringify(value)).kind).toBe("invalid");
  }
  expect(parseServerFrame("{").kind).toBe("invalid");
  expect(parseServerFrame(JSON.stringify({ type: "future_progress", data: [1, "inspect"] }))).toEqual({ kind: "future", message: { type: "future_progress", data: [1, "inspect"] } });
  expect(parseServerFrame(JSON.stringify({ type: "stream_chunk", text: "hi", content_type: "text", additive: "inspect" }))).toMatchObject({ kind: "known", message: { additive: "inspect" } });
});

test("the browser wire bundle runs with dynamic code generation disabled", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../src/browser/wire.ts", import.meta.url).pathname], target: "browser", format: "cjs", minify: true,
  });
  expect(result.success).toBe(true);
  const artifact = result.outputs.at(0);
  if (artifact === undefined) throw new Error("Missing browser bundle");
  const script = await artifact.text();
  const output: unknown = runInNewContext(`${script}; module.exports.parseServerFrame('{"type":"stream_chunk","text":"hello","content_type":"text"}');`, { TextEncoder, module: { exports: {} } }, { contextCodeGeneration: { strings: false, wasm: false }, timeout: 5000 });
  expect(output).toEqual({ kind: "known", message: { type: "stream_chunk", text: "hello", content_type: "text" } });
});

test("browser operation validators run without dynamic code generation", async () => {
  const bundle = await Bun.build({ entrypoints: [new URL("../src/browser/operation_validators.generated.js", import.meta.url).pathname], target: "browser", format: "cjs", minify: true });
  expect(bundle.success).toBe(true);
  const script = await bundle.outputs.at(0)?.text();
  expect(script).toBeDefined();
  const result: unknown = runInNewContext(`${script}; [module.exports.validOperationInput('history_page', {segment:2, before:40}), module.exports.validOperationInput('history_page', {before:'active'}), module.exports.validOperationResult('edit', {ref:'1', edited:true})];`, { TextEncoder, module: { exports: {} } }, { contextCodeGeneration: { strings: false, wasm: false }, timeout: 5000 });
  expect(result).toEqual([true, false, true]);
});
