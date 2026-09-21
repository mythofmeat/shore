import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleBash } from "../src/tools/bash.ts";
import { dispatchTool, dispatchWithinDeadline, type ToolContext } from "../src/tools/dispatch.ts";
import { runToolUse, type ToolExecution } from "../src/tools/execute.ts";
import { ALL_TOOLS, BUILTIN_TOOL_SCHEMAS, renderToolDefs } from "../src/tools/registry.ts";
import { DEFAULT_RETRIEVAL_CONFIG } from "../src/tools/workspace.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; } catch (error) { return String(error); }
  throw new Error("expected the operation to fail");
}

async function world() {
  const root = await mkdtemp(join(tmpdir(), "shore-bash-"));
  roots.push(root);
  const workspaceDir = join(root, "workspace");
  const ctx: ToolContext = {
    workspaceDir, characterName: "Juniper Vale", characterDataDir: root,
    imageDir: root, conversationDir: root, historyDbPath: join(root, "history.db"), configDir: root,
    searchConfig: { api_key_env: "UNUSED", result_limit: 5, search_depth: "basic", include_answer: false },
    retrievalConfig: DEFAULT_RETRIEVAL_CONFIG, retrievalMode: "auto",
  };
  const frames: ServerMessage[] = [];
  const exec: ToolExecution = {
    ctx, sendDirect: (frame) => frames.push(frame), schemas: BUILTIN_TOOL_SCHEMAS,
    limits: { max_result_chars: 50_000, timeout_ms: 5_000 },
    now: () => new Date().toISOString(), newMessageId: () => "unused",
  };
  const run = (command: string, workdir?: string) => runToolUse({
    id: "bash-call", name: "bash", input: { command, ...(workdir === undefined ? {} : { workdir }) },
  }, exec, []);
  return { root, ctx, exec, frames, run };
}

describe("bash on Shore's tool surface", () => {
  test("one shell replaces the basic command-line tools and keeps retrieval and services", () => {
    const names = renderToolDefs({ enabled_tools: ["*"], enabled_subagents: [] }, "Ada", "User").map((tool) => tool.name);
    expect(names).toContain("bash");
    for (const name of ["delete", "git", "fetch_url", "roll_dice"]) expect(names).not.toContain(name);
    for (const name of ["search", "search_chat_logs", "web_search", "generate_image", "model_history"]) expect(names).toContain(name);
    expect(renderToolDefs({ enabled_tools: ["read"], enabled_subagents: [] }, "Ada", "User").map((d) => d.name)).toEqual(["read"]);
    expect(ALL_TOOLS.filter((tool) => tool.name === "bash")).toHaveLength(1);
  });

  test.each([{}, { command: 42 }, { command: "" }, { command: "pwd", workdir: 3 }, { command: "pwd", surprise: true }])(
    "rejects malformed input before touching the workspace: %j", async (input) => {
      const { exec, ctx } = await world();
      const result = await runToolUse({ id: "bad", name: "bash", input }, exec, []);
      expect(result.rejected).toBe(true);
      expect(result.isError).toBe(true);
      expect(await Bun.file(join(ctx.workspaceDir, "marker")).exists()).toBe(false);
    },
  );

  test("runs real Bash with quoting, heredocs, pipelines, edits, search, moves, and deletion", async () => {
    const { run, ctx, frames } = await world();
    const result = await run(`mkdir -p 'a folder'
cat > 'a folder/note.txt' <<'NOTE'
the tide came in
$HOME stays literal
NOTE
sed -i 's/came in/went out/' 'a folder/note.txt'
matches=("a folder"/*.txt)
cat "\${matches[0]}" | grep tide
mv 'a folder/note.txt' saved.txt
printf 'temporary' > discard.txt
rm discard.txt
printf 'diagnostic' >&2`);
    expect(result.isError).toBe(false);
    expect(result.raw).toContain("the tide went out");
    expect(result.raw).toContain("stderr:\ndiagnostic");
    expect(await readFile(join(ctx.workspaceDir, "saved.txt"), "utf8")).toContain("$HOME stays literal");
    expect(await Bun.file(join(ctx.workspaceDir, "discard.txt")).exists()).toBe(false);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ type: "tool_call", tool_name: "bash" });
    expect(frames[1]).toMatchObject({ type: "tool_result", tool_name: "bash", is_error: false });
    expect(result.block).toMatchObject({ type: "tool_result", tool_use_id: "bash-call", is_error: false });
  });

  test("uses a fresh shell for each call, with relative or absolute working directories", async () => {
    const { run, root, ctx } = await world();
    await run("mkdir child; cd child; export SHORE_BASH_TRANSIENT=changed");
    expect((await run('printf "%s|%s|%s" "$PWD" "$SHORE_WORKSPACE_DIR" "${SHORE_BASH_TRANSIENT-unset}"')).raw)
      .toContain(`${ctx.workspaceDir}|${ctx.workspaceDir}|unset`);
    expect((await run("pwd", "child")).raw).toContain(join(ctx.workspaceDir, "child"));
    expect((await run("pwd", root)).raw).toContain(`workdir: ${root}`);
    expect((await run("pwd", "..")).raw).toContain(`workdir: ${root}`);
  });

  test("returns nonzero exit status and both output streams to the model", async () => {
    const { run } = await world();
    const result = await run("printf out; printf err >&2; exit 7");
    expect(result.isError).toBe(true);
    expect(result.value).toMatchObject({ exit_code: 7, stdout: "out", stderr: "err" });
    expect(result.raw).toContain("bash: exit 7");
    expect(result.block).toMatchObject({ is_error: true });
    expect((await run("false | cat")).isError).toBe(true);
  });

  test("stdin is closed instead of waiting for user input", async () => {
    const { run } = await world();
    expect((await run("if read -r value; then exit 9; fi; printf closed")).raw).toContain("closed");
  });

  test("git commits carry the character identity", async () => {
    const { run } = await world();
    const result = await run("git init -q && printf note > note.md && git add note.md && git commit -qm initial && git log -1 --format='%an <%ae>'");
    expect(result.isError).toBe(false);
    expect(result.raw).toContain("Juniper Vale <juniper-vale@shore.local>");
  });

  test("curl fetches URLs from the daemon's network", async () => {
    const { run } = await world();
    const server = Bun.serve({ port: 0, fetch: () => new Response("a fetched page") });
    try {
      const result = await run(`curl --fail --silent --show-error http://127.0.0.1:${server.port}/`);
      expect(result.isError).toBe(false);
      expect(result.raw).toContain("a fetched page");
    } finally { await server.stop(true); }
  });

  test("bounds captured output while continuing to drain stdout and stderr", async () => {
    const { run, exec } = await world();
    exec.limits.max_result_chars = 200;
    const result = await run("head -c 1100000 /dev/zero | tr '\\0' x; head -c 1100000 /dev/zero | tr '\\0' y >&2; printf done > done.txt");
    expect(result.isError).toBe(false);
    expect(result.raw.length).toBeLessThan(2 * 1024 * 1024 + 1000);
    expect(result.raw).toContain("[process output truncated]");
    expect(result.window?.truncated).toBe(true);
    expect((await run("cat done.txt")).raw).toContain("done");
  });

  test("queues changed prompt files, including deletion and writes before failure", async () => {
    const { run, ctx } = await world();
    const queued: string[] = [];
    ctx.deferEdit = (path) => { queued.push(path); };
    const result = await run("printf memory > MEMORY.md; printf soul > SOUL.md; exit 1");
    expect(result.isError).toBe(true);
    expect(queued).toEqual(["SOUL.md", "MEMORY.md"]);
    queued.length = 0;
    await run("cat MEMORY.md; printf memory > MEMORY.md; printf note > note.md");
    expect(queued).toEqual([]);
    await run("rm SOUL.md");
    expect(queued).toEqual(["SOUL.md"]);
  });

  test("dry-run blocks Bash before creating any files", async () => {
    const { ctx } = await world();
    ctx.dryRun = true;
    expect(await failure(dispatchTool("bash", { command: "touch marker" }, ctx))).toContain("dry-run");
    expect(await Bun.file(join(ctx.workspaceDir, "marker")).exists()).toBe(false);
  });

  test("already-cancelled calls do not start commands", async () => {
    const { ctx } = await world();
    ctx.signal = AbortSignal.abort(new Error("stop"));
    expect(await failure(dispatchTool("bash", { command: "touch marker" }, ctx))).toContain("stop");
    expect(await Bun.file(join(ctx.workspaceDir, "marker")).exists()).toBe(false);
  });

  test("timeout kills descendants and queues edits made before cancellation", async () => {
    const { ctx } = await world();
    const queued: string[] = [];
    ctx.deferEdit = (path) => { queued.push(path); };
    expect(await failure(dispatchWithinDeadline("bash", {
      command: "printf partial > MEMORY.md; (trap '' TERM; sleep 1; printf leaked > leaked.txt) & wait",
    }, ctx, 150))).toContain("timed out");
    await Bun.sleep(1100);
    expect(await readFile(join(ctx.workspaceDir, "MEMORY.md"), "utf8")).toBe("partial");
    expect(queued).toEqual(["MEMORY.md"]);
    expect(await Bun.file(join(ctx.workspaceDir, "leaked.txt")).exists()).toBe(false);
  });

  test("caller cancellation reaches the command and its child processes", async () => {
    const { ctx } = await world();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const call = dispatchTool("bash", { command: "printf ready > ready; sleep 10; touch leaked" }, ctx);
    for (let attempts = 0; attempts < 100 && !await Bun.file(join(ctx.workspaceDir, "ready")).exists(); attempts += 1) await Bun.sleep(10);
    controller.abort(new Error("user cancelled"));
    expect(await failure(call)).toContain("user cancelled");
    expect(await Bun.file(join(ctx.workspaceDir, "leaked")).exists()).toBe(false);
  });

  test("missing workspace and working directory produce useful errors", async () => {
    expect(await failure(handleBash({ command: "pwd" }, "", "Ada"))).toContain("workspace not configured");
    const { run } = await world();
    const result = await run("pwd", "missing");
    expect(result.isError).toBe(true);
    expect(result.raw).toContain("could not run bash");
  });
});
