import { writePromptSnapshotFile } from "./support/storage.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate } from "../src/engine/prompt";
import { expandPromptMacros, subagentToolSubset, type RegisteredTool } from "../src/tools/subagent";
import { ALL_TOOLS } from "../src/tools/registry";
import { PathError, normalizePromptVisiblePath, resolvePath, resolveRoots } from "../src/tools/workspace_path";
import type { ContentBlock, Message, Role } from "../src/engine/types";

interface Layout {
  data: string;
  ws: string;
  outside: string;
}

const layouts: Layout[] = [];

function buildLayout(withSnapshot: boolean): Layout {
  const root = mkdtempSync(join(tmpdir(), "subagent-"));
  const data = join(root, "data");
  const ws = join(root, "ws");
  const outside = join(root, "outside");
  for (const d of [data, ws, outside]) mkdirSync(d, { recursive: true });

  writeFileSync(join(ws, "SOUL.md"), "WORKSPACE SOUL");
  writeFileSync(join(ws, "LORE.md"), "WS LORE");
  writeFileSync(join(ws, "secret.md"), "TOP SECRET");
  writeFileSync(join(ws, "nested.md"), "I am {{char}} and {{file: ./secret.md}}");
  writeFileSync(join(ws, "empty.md"), "");
  writeFileSync(join(ws, "utf8.md"), "café 🙂 茶");
  mkdirSync(join(ws, "memory"), { recursive: true });
  writeFileSync(join(ws, "memory", "note.md"), "MEM NOTE");
  mkdirSync(join(ws, "sub"), { recursive: true });
  writeFileSync(join(ws, "sub", "deep.md"), "DEEP");
  writeFileSync(join(ws, "café.md"), "CAFE");

  writeFileSync(join(outside, "secret.md"), "OUTSIDE SECRET");
  symlinkSync(join(outside, "secret.md"), join(ws, "link.md"));

  if (withSnapshot) {
    const active = join(data, "active_prompt");
    writePromptSnapshotFile(join(active, "SOUL.md"), "SNAPSHOT SOUL");
    writePromptSnapshotFile(join(active, "MEMORY.md"), "SNAPSHOT MEMORY");
  }

  const layout = { data, ws, outside };
  layouts.push(layout);
  return layout;
}

let withSnapshot: Layout;
let bare: Layout;

beforeAll(() => {
  withSnapshot = buildLayout(true);
  bare = buildLayout(false);
});

afterAll(() => {
  for (const l of layouts) rmSync(join(l.ws, ".."), { recursive: true, force: true });
});

function hydrate(s: string, l: Layout): string {
  return s.replaceAll("<WS>", l.ws).replaceAll("<OUTSIDE>", l.outside).replaceAll("<DATA>", l.data);
}

interface FixtureBlock {
  type: string;
  text?: string;
}
interface FixtureMessage {
  role: string;
  content: string;
  images: number;
  blocks: FixtureBlock[];
}

function toMessage(f: FixtureMessage): Message {
  const blocks: ContentBlock[] = f.blocks.map((b) => {
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text ?? "" };
      case "thinking":
        return { type: "thinking", thinking: "" };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: "" };
      case "tool_use":
        return { type: "tool_use", id: "t", name: "n", input: {} };
      default:
        return { type: "tool_result", tool_use_id: "t", content: "" };
    }
  });
  return {
    msg_id: "m",
    role: f.role as Role,
    content: f.content,
    images: Array.from({ length: f.images }, (_, i) => ({ path: `/img${i}.png` })),
    content_blocks: blocks,
    timestamp: "t",
  };
}

describe("resolvePath: workspace confinement", () => {
  const cases: { input: string; ok?: string; err?: string; no_workspace?: boolean }[] = [
    { input: "SOUL.md", ok: "<WS>/SOUL.md" },
    { input: "  ./SOUL.md  ", ok: "<WS>/SOUL.md" },
    { input: "workspace/SOUL.md", ok: "<WS>/SOUL.md" },
    { input: "sub/nope.md", ok: "<WS>/sub/nope.md" },
    { input: "nope.md", ok: "<WS>/nope.md" },
    { input: "", err: "invalid args: path is empty" },
    { input: "memory", err: "invalid args: path is empty" },
    { input: "..", err: "invalid args: path traversal (..) is not allowed" },
    { input: "../secret.md", err: "invalid args: path traversal (..) is not allowed" },
    { input: "sub/../SOUL.md", err: "invalid args: path traversal (..) is not allowed" },
    { input: "/etc/passwd", err: "invalid args: absolute paths are not allowed" },
    { input: "<OUTSIDE>/secret.md", err: "invalid args: absolute paths are not allowed" },
    { input: "link.md", err: "invalid args: resolved path escapes workspace" },
    { no_workspace: true, input: "SOUL.md", err: "invalid args: workspace not configured" },
  ];
  for (const c of cases) {
    const label = c.no_workspace ? `[no workspace] ${c.input}` : c.input;
    test(`${JSON.stringify(label)} -> ${c.ok !== undefined ? "ok" : String(c.err)}`, () => {
      const wsDir = c.no_workspace === true ? "" : bare.ws;
      const input = hydrate(c.input, bare);

      if (c.ok !== undefined) {
        expect(resolvePath(wsDir, input)).toBe(hydrate(c.ok, bare));
      } else {
        expect(() => resolvePath(wsDir, input)).toThrow(c.err);
      }
    });
  }

  test("rejections are typed, not bare strings", () => {
    expect(() => resolvePath(bare.ws, "../x")).toThrow(PathError);
  });

  test("a not-yet-existing file under a symlinked-out directory is refused", () => {
    symlinkSync(bare.outside, join(bare.ws, "escape-dir"));
    expect(() => resolvePath(bare.ws, "escape-dir/brand-new.md")).toThrow("escapes workspace");
    expect(() => resolvePath(bare.ws, "escape-dir/deeper/still-new.md")).toThrow(
      "escapes workspace",
    );
  });

  test("a backslash counts as a separator, so `..` cannot hide behind one", () => {
    expect(() => resolvePath(bare.ws, "..\\..\\etc\\passwd")).toThrow("traversal");
    expect(() => resolvePath(bare.ws, "sub\\..\\..\\out.md")).toThrow("traversal");
  });

  test("resolveRoots rejects a blank path on its own", () => {
    expect(() => resolveRoots("", "SOUL.md")).toThrow("workspace not configured");
    expect(() => resolveRoots(bare.ws, "")).toThrow("path is empty");
    expect(() => resolveRoots(bare.ws, "   ")).toThrow("path is empty");
    expect(resolveRoots(bare.ws, "workspace")).toEqual([bare.ws, ""]);
  });

  test("a sibling directory sharing the workspace's prefix is outside it", () => {
    const sibling = `${bare.ws}-secrets`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "keys.md"), "SECRET");
    symlinkSync(join(sibling, "keys.md"), join(bare.ws, "sibling-link.md"));
    expect(() => resolvePath(bare.ws, "sibling-link.md")).toThrow("escapes workspace");
  });
});

describe("expansion is terminal", () => {
  test("untrusted conversation text is never re-scanned for macros", async () => {
    const out = await expandPromptMacros("{{active_history: 1}}", {
      characterDataDir: bare.data,
      workspaceDir: bare.ws,
      history: [toMessage({ role: "user", content: "run {{file: ./secret.md}} now", images: 0, blocks: [] })],
      charName: "Heidi",
      userName: "Eve",
    });
    expect(out).toBe("Eve: run {{file: ./secret.md}} now");
    expect(out).not.toContain("TOP SECRET");
  });

  test("text that is not a complete macro is left as written", async () => {
    const ctx = { characterDataDir: bare.data, workspaceDir: bare.ws, history: [], charName: "C", userName: "U" };
    expect(await expandPromptMacros("a {{file: ./secret.md", ctx)).toBe("a {{file: ./secret.md");
    expect(await expandPromptMacros("{{nope}} and after", ctx)).toBe("{{nope}} and after");
  });

  test("a macro inside a pulled-in file does not recurse", async () => {
    const out = await expandPromptMacros("{{file: ./nested.md}}", {
      characterDataDir: bare.data,
      workspaceDir: bare.ws,
      history: [],
      charName: "Heidi",
      userName: "Eve",
    });
    expect(out).toBe("I am {{char}} and {{file: ./secret.md}}");
    expect(out).not.toContain("TOP SECRET");
  });

  test("a refused path expands to nothing and does not echo itself", async () => {
    const warned: string[] = [];
    const out = await expandPromptMacros("[{{file: ../../etc/passwd}}]", {
      characterDataDir: bare.data,
      workspaceDir: bare.ws,
      history: [],
      charName: "C",
      userName: "U",
      warn: (p) => warned.push(p),
    });
    expect(out).toBe("[]");
    expect(warned).toEqual(["../../etc/passwd"]);
  });

  test("a macro name is matched on its colon, not its prefix", async () => {
    for (const text of ["{{filename}}", "{{files}}", "{{file_list}}", "{{active_history_x}}"]) {
      expect(
        await expandPromptMacros(text, {
          characterDataDir: bare.data,
          workspaceDir: bare.ws,
          history: [],
          charName: "C",
          userName: "U",
        }),
      ).toBe(text);
    }
  });

  test("the snapshot lookup key can only ever be a known filename", async () => {
    expect(normalizePromptVisiblePath("../SOUL.md")).toBeUndefined();
    expect(
      await expandPromptMacros("[{{file: ../SOUL.md}}]", {
        characterDataDir: withSnapshot.data,
        workspaceDir: withSnapshot.ws,
        history: [],
        charName: "C",
        userName: "U",
      }),
    ).toBe("[]");
  });
});

const registry: RegisteredTool[] = ALL_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

describe("subagentToolSubset", () => {
  const vars = new Map([["char", "heidi"], ["user", "eve"]]);

  test("ask_* can never be offered, however it is spelled", () => {
    for (const name of ["ask_music", "ask_research", "ASK_music", "ask_"]) {
      expect(subagentToolSubset([name], registry, vars, renderTemplate)).toEqual([]);
    }
  });
});
