import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { helperCommand, WorkspaceHelper } from "../src/tools/workspace_helper.ts";
import { decodeToolValue, WORKSPACE_OPS, type EncodedToolValue } from "../src/tools/workspace_ops.ts";
import { toolMediaOf } from "../src/tools/media.ts";
import { InvalidArgs, ToolIoError } from "../src/tools/errors.ts";
import { testTmp } from "./support/tmp.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const helpers: WorkspaceHelper[] = [];

afterEach(() => {
  for (const helper of helpers.splice(0)) helper.close();
});

function sourceHelper(env: NodeJS.ProcessEnv = process.env): WorkspaceHelper {
  const [command = process.execPath, ...args] = helperCommand(false);
  const helper = new WorkspaceHelper("test", async () => ({ command, args, env }));
  helpers.push(helper);
  return helper;
}

async function workspace(): Promise<string> {
  const root = testTmp("workspace-helper");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "tide.md"), "the tide came in\n![chart](chart.png)\n");
  await writeFile(join(root, "notes", "chart.png"), PNG);
  return root;
}

async function outcome(work: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await work };
  } catch (error) {
    return { error };
  }
}

describe("the workspace helper", () => {
  test("answers the same as the in-process operations, images included", async () => {
    const root = await workspace();
    const helper = sourceHelper();
    const args = { input: { file_path: "notes/tide.md" }, workspaceDir: root };
    const remote = decodeToolValue(await helper.call("read", args) as EncodedToolValue);
    const local = decodeToolValue(await WORKSPACE_OPS.read(args));
    expect(toolMediaOf(remote)).toEqual(toolMediaOf(local));
    expect(toolMediaOf(remote)?.media[0]?.mime_type).toBe("image/png");
    expect(String(toolMediaOf(remote)?.value)).toContain("the tide came in");
  });

  test("edits files and reports their contents and absence", async () => {
    const root = await workspace();
    const helper = sourceHelper();
    expect(await helper.call("edit", { input: { file_path: "notes/tide.md", old_string: "came in", new_string: "went out" }, workspaceDir: root }))
      .toContain("replaced 1 exact occurrence");
    expect(await readFile(join(root, "notes", "tide.md"), "utf8")).toContain("the tide went out");
    const [found, missing] = await helper.call("readFiles", { paths: [join(root, "notes", "tide.md"), join(root, "nope.md")] }) as [
      { data: string }, { error: { code: string } },
    ];
    expect(Buffer.from(found.data, "base64").toString("utf8")).toContain("went out");
    expect(missing.error.code).toBe("ENOENT");
  });

  test("keeps the tool's error types and messages", async () => {
    const root = await workspace();
    const helper = sourceHelper();
    const unchanged = await outcome(helper.call("edit", { input: { file_path: "notes/tide.md", old_string: "absent", new_string: "x" }, workspaceDir: root })) as { error: Error };
    expect(unchanged.error).toBeInstanceOf(InvalidArgs);
    expect(unchanged.error.message).toBe(`invalid args: ${join(root, "notes", "tide.md")}: old_string has no exact match; file unchanged`);
    const binary = await outcome(helper.call("read", { input: { file_path: "notes/chart.png", offset: 2 }, workspaceDir: root })) as { error: Error };
    expect(binary.error).toBeInstanceOf(InvalidArgs);
    await writeFile(join(root, "bad.txt"), Buffer.from([0xff, 0xfe, 0x00]));
    const io = await outcome(helper.call("read", { input: { file_path: "bad.txt" }, workspaceDir: root })) as { error: Error };
    expect(io.error).toBeInstanceOf(ToolIoError);
    const missing = await outcome(helper.call("realpath", { path: join(root, "absent") })) as { error: NodeJS.ErrnoException };
    expect(missing.error.code).toBe("ENOENT");
    const unknown = await outcome(helper.call("format_disk", {})) as { error: Error };
    expect(unknown.error.message).toBe("format_disk: not yet implemented");
  });

  test("snapshots and restores entries, symlinks as links", async () => {
    const root = await workspace();
    await symlink("/etc/hostname", join(root, "link"));
    const helper = sourceHelper();
    const entries = new Map(await helper.call("snapshot", { root }) as [string, unknown][]);
    expect(entries.get("link")).toEqual({ kind: "symlink", target: "/etc/hostname" });
    expect(entries.get("notes")).toMatchObject({ kind: "directory" });
    await helper.call("restore", { path: join(root, "notes", "tide.md"), entry: null });
    expect(await outcome(readFile(join(root, "notes", "tide.md")))).toMatchObject({ error: { code: "ENOENT" } });
    await helper.call("restore", { path: join(root, "notes", "tide.md"), entry: entries.get("notes/tide.md") });
    expect(await readFile(join(root, "notes", "tide.md"), "utf8")).toContain("the tide came in");
  });

  test("creates a file only where none exists", async () => {
    const root = await workspace();
    const helper = sourceHelper();
    const data = Buffer.from("guidance\n").toString("base64");
    expect(await helper.call("createFile", { path: join(root, "TOOLS.md"), data })).toBe(true);
    expect(await helper.call("createFile", { path: join(root, "TOOLS.md"), data: Buffer.from("other").toString("base64") })).toBe(false);
    await symlink(join(root, "elsewhere.md"), join(root, "dangling.md"));
    expect(await helper.call("createFile", { path: join(root, "dangling.md"), data })).toBe(false);
    expect(await outcome(readFile(join(root, "elsewhere.md")))).toMatchObject({ error: { code: "ENOENT" } });
    expect(await readFile(join(root, "TOOLS.md"), "utf8")).toBe("guidance\n");
  });

  test("a cancelled call rejects with its reason while other calls still answer", async () => {
    const root = await workspace();
    await mkdir(join(root, "big"));
    for (let index = 0; index < 400; index += 1) await writeFile(join(root, "big", `${String(index)}.md`), "x\n");
    const helper = sourceHelper();
    const controller = new AbortController();
    const reason = new Error("stop reading");
    const cancelled = outcome(helper.call("read", { input: { file_path: "big/" }, workspaceDir: root }, controller.signal));
    controller.abort(reason);
    const other = helper.call("exists", { paths: [root, join(root, "nope")] });
    expect(await cancelled).toEqual({ error: reason });
    expect(await other).toEqual([true, false]);
  });

  test("starts again after the helper process dies", async () => {
    const root = await workspace();
    const helper = sourceHelper();
    expect(await helper.call("exists", { paths: [root] })).toEqual([true]);
    const first = helper.pid;
    process.kill(first ?? 0, "SIGKILL");
    await Bun.sleep(100);
    expect(await helper.call("exists", { paths: [root] })).toEqual([true]);
    expect(helper.pid).not.toBe(first);
  });

  test("a helper that cannot start fails the call with what it printed", async () => {
    const helper = new WorkspaceHelper("broken", async () => ({ command: process.execPath, args: ["-e", "console.error('no such user'); process.exit(3)"], env: process.env }));
    helpers.push(helper);
    const failed = await outcome(helper.call("exists", { paths: ["/"] })) as { error: Error };
    expect(failed.error.message).toBe("the workspace helper for broken stopped (exit code 3): no such user");
  });
});
