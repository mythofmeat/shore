import { expect, test } from "bun:test";

import { Texts } from "../src/texts/texts.ts";
import { errorText, InvalidArgs, NotImplemented, ToolIoError, ToolTimedOut } from "../src/tools/errors.ts";

const mine = Texts.from({
  tool_invalid_args: "BAD: {{error}}",
  tool_io: "IO: {{error}}",
  tool_not_implemented: "NO {{tool}}",
  tool_timed_out_unconfirmed: "LATE {{seconds}}",
  tool_timed_out: "STOPPED {{seconds}}{{#if stopped}} after printing:\n{{output}}{{/if}}",
  tool_stderr: "ERR:\n{{stderr}}",
});

test("a failed call is told in the texts for its kind of failure, each given the reason", () => {
  expect(errorText(mine, new InvalidArgs("path is empty"))).toBe("BAD: path is empty");
  expect(errorText(mine, new ToolIoError("no such file"))).toBe("IO: no such file");
  expect(errorText(mine, new NotImplemented("mcp__x__y"))).toBe("NO mcp__x__y");
  expect(errorText(mine, new ToolTimedOut(30, false))).toBe("LATE 30");
  expect(errorText(mine, new ToolTimedOut(30, true))).toBe("STOPPED 30");
  expect(errorText(mine, new ToolTimedOut(30, true, { stdout: "partial\n", stderr: "warn\n" }))).toBe("STOPPED 30 after printing:\npartial\nERR:\nwarn");
  expect(errorText(mine, new ToolTimedOut(30, true, { stdout: "", stderr: "" }))).toBe("STOPPED 30 after printing:\n");
});

test("any other failure is told as its message, or as itself when it isn't an error", () => {
  expect(errorText(mine, new Error("the disk is full"))).toBe("the disk is full");
  expect(errorText(mine, "thrown as text")).toBe("thrown as text");
});

test("each kind of failure keeps a message for the log that says what it is, and is named for it", () => {
  expect([new InvalidArgs("a"), new ToolIoError("b"), new NotImplemented("c"), new ToolTimedOut(5, true)].map(String)).toEqual([
    "InvalidArgs: invalid args: a",
    "ToolIoError: io: b",
    "NotImplemented: c: not yet implemented",
    "ToolTimedOut: timed out after 5s",
  ]);
  expect(errorText(new Texts(), new ToolTimedOut(5, true, { stdout: "out", stderr: "" }))).toBe("timed out after 5s and was cancelled\nOutput before it was stopped:\nout");
});
