import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

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
