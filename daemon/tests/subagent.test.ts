import { writePromptSnapshotFile } from "./support/storage.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./engine_captures/subagent.json";
import { renderTemplate } from "../src/engine/prompt";
import {
  MAX_HISTORY_MESSAGES,
  expandPromptMacros,
  messageDisplayText,
  missingModelMessage,
  renderHistorySlice,
  subagentToolSubset,
  templateVars,
  type RegisteredTool,
} from "../src/tools/subagent";
import { ALL_TOOLS } from "../src/tools/registry";
import {
  PathError,
  normalizePromptVisiblePath,
  normalizeWorkspacePath,
  resolvePath,
  resolveRoots,
} from "../src/tools/workspace_path";
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

const histories = new Map<string, Message[]>(
  (fixture.histories as { name: string; messages: FixtureMessage[] }[]).map((h) => [
    h.name,
    h.messages.map(toMessage),
  ]),
);

const exfilHistory = (fixture.exfil_history as FixtureMessage[]).map(toMessage);

describe("resolvePath: workspace confinement", () => {
  for (const c of fixture.resolve_path as {
    input: string;
    ok?: string;
    err?: string;
    no_workspace?: boolean;
  }[]) {
    const label = c.no_workspace ? `[no workspace] ${c.input}` : c.input;
    test(`${JSON.stringify(label)} -> ${c.ok !== undefined ? "ok" : c.err}`, () => {
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

describe("normalizePromptVisiblePath", () => {
  for (const c of fixture.prompt_visible as { input: string; output: string | null }[]) {
    test(`${JSON.stringify(c.input)} -> ${c.output ?? "none"}`, () => {
      expect(normalizePromptVisiblePath(c.input) ?? null).toEqual(c.output);
    });
  }

  test("normalization runs to a fixed point, not once", () => {
    expect(normalizeWorkspacePath("workspace/./SOUL.md")).toBe("SOUL.md");
    expect(normalizeWorkspacePath("//workspace//SOUL.md")).toBe("SOUL.md");
    expect(normalizeWorkspacePath("./workspace/SOUL.md")).toBe("SOUL.md");

    expect(normalizePromptVisiblePath("workspace/./workspace/./SOUL.md")).toBe("SOUL.md");
  });
});

describe("expandPromptMacros", () => {
  for (const c of fixture.expand as {
    snapshot: boolean;
    history: string;
    text: string;
    output: string;
  }[]) {
    const tag = `${c.snapshot ? "snap" : "bare"}/${c.history}`;
    test(`[${tag}] ${JSON.stringify(c.text)}`, async () => {
      const layout = c.snapshot ? withSnapshot : bare;
      const history = c.history === "exfil_pair" ? exfilHistory : [];
      const out = await expandPromptMacros(hydrate(c.text, layout), {
        characterDataDir: layout.data,
        workspaceDir: layout.ws,
        history,
        charName: "Heidi",
        userName: "Eve",
      });
      expect(out).toBe(hydrate(c.output, layout));
    });
  }
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

describe("two-phase render", () => {
  const tp = fixture.two_phase as {
    authored: string;
    vars: Record<string, string>;
    soul_contents: string;
    output: string;
  };

  test("var pass runs first, macro pass second", async () => {
    const root = mkdtempSync(join(tmpdir(), "two-phase-"));
    const ws = join(root, "ws");
    const data = join(root, "data");
    mkdirSync(ws, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(ws, "SOUL.md"), tp.soul_contents);

    const vars = new Map(Object.entries(tp.vars));
    const phase1 = renderTemplate(tp.authored, vars);
    const out = await expandPromptMacros(phase1, {
      characterDataDir: data,
      workspaceDir: ws,
      history: [
        toMessage({ role: "user", content: "hey", images: 0, blocks: [] }),
        toMessage({ role: "assistant", content: "hi there", images: 0, blocks: [] }),
      ],
      charName: "Heidi",
      userName: "Eve",
    });

    expect(out).toBe(tp.output);
    expect(out).toContain("I am Heidi");
    expect(out).toContain("soul says {{char}}");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("renderHistorySlice", () => {
  for (const c of fixture.history_slices as {
    history: string;
    arg: string;
    output: string;
  }[]) {
    test(`${c.history} @ ${JSON.stringify(c.arg)}`, () => {
      const h = histories.get(c.history);
      expect(h).toBeDefined();
      expect(renderHistorySlice(h as Message[], c.arg, "Heidi", "Eve")).toBe(c.output);
    });
  }

  test("the cap holds independently of the requested count", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      toMessage({ role: "user", content: `m${i}`, images: 0, blocks: [] }),
    );
    const out = renderHistorySlice(many, "250", "C", "U");
    expect(out.split("\n")).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(out.startsWith("U: m150")).toBe(true);
    expect(out.endsWith("U: m249")).toBe(true);
  });

  test("timed history carries the same wall-clock markers the conversation shows", () => {
    const at = (ts: string, content: string): Message => ({
      ...toMessage({ role: "user", content, images: 0, blocks: [] }),
      timestamp: ts,
    });
    const out = renderHistorySlice(
      [
        at("2026-09-01T13:00:00Z", "first"),
        at("2026-09-01T13:05:00Z", "still talking"),
        at("2026-09-01T18:00:00Z", "hours later"),
      ],
      "3",
      "Heidi",
      "Eve",
      "Australia/Canberra",
    );

    expect(out.split("\n")).toEqual([
      "[Tuesday 2026-09-01 · 11:00 PM]",
      "Eve: first",
      "Eve: still talking",
      "[5 hours later · Wednesday 2026-09-02 · 4:00 AM]",
      "Eve: hours later",
    ]);
  });

  test("untimed history is rendered exactly as before", () => {
    const out = renderHistorySlice(
      [toMessage({ role: "user", content: "hi", images: 0, blocks: [] })],
      "1",
      "Heidi",
      "Eve",
      "Australia/Canberra",
    );
    expect(out).toBe("Eve: hi");
  });

  test("a non-numeric count yields nothing rather than everything", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      toMessage({ role: "user", content: `m${i}`, images: 0, blocks: [] }),
    );
    for (const arg of ["all", "", "-1", "2.5", "1e3", " 2 ", "0x2", "+2"]) {
      expect(renderHistorySlice(many, arg, "C", "U")).toBe("");
    }
  });
});

describe("messageDisplayText", () => {
  for (const c of fixture.display_texts as {
    history: string;
    index: number;
    output: string;
  }[]) {
    test(`${c.history}[${c.index}]`, () => {
      const h = histories.get(c.history) as Message[];
      expect(messageDisplayText(h[c.index] as Message)).toBe(c.output);
    });
  }

  test("thinking and tool blocks never reach the transcript", () => {
    const msg = toMessage({
      role: "assistant",
      content: "",
      images: 0,
      blocks: [
        { type: "thinking" },
        { type: "text", text: "said" },
        { type: "tool_use" },
        { type: "tool_result" },
      ],
    });
    expect(messageDisplayText(msg)).toBe("said");
  });
});

const registry: RegisteredTool[] = ALL_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters,
}));

const MCP_TOOLS = ["mcp__hue__off", "mcp__hue__on", "mcp__nanoleaf__scene"];

const mcpMatcher = {
  namesMatching(allowed: readonly string[]) {
    return MCP_TOOLS.filter((name) =>
      allowed.some((pattern) =>
        pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
      ),
    ).map((name) => ({ name, description: "", parameters: {} }));
  },
};

describe("subagentToolSubset", () => {
  const vars = new Map([["char", "heidi"], ["user", "eve"]]);

  for (const c of fixture.tool_subsets as {
    allowed: string[];
    mcp: boolean;
    names: string[];
  }[]) {
    test(`${JSON.stringify(c.allowed)}${c.mcp ? " +mcp" : ""}`, () => {
      const defs = subagentToolSubset(
        c.allowed,
        registry,
        vars,
        renderTemplate,
        c.mcp ? mcpMatcher : undefined,
      );
      expect(defs.map((d) => d.name)).toEqual(c.names);
    });
  }

  test("ask_* can never be offered, however it is spelled", () => {
    for (const name of ["ask_music", "ask_research", "ASK_music", "ask_"]) {
      expect(subagentToolSubset([name], registry, vars, renderTemplate)).toEqual([]);
    }
  });

  test("tool names match exactly, never by prefix", () => {
    expect(subagentToolSubset(["search"], registry, vars, renderTemplate).map((d) => d.name)).toEqual([
      "search",
    ]);
    expect(
      subagentToolSubset(["search_chat_logs"], registry, vars, renderTemplate).map((d) => d.name),
    ).toEqual(["search_chat_logs"]);

    for (const partial of ["web", "gen", "sear", "model"]) {
      expect(subagentToolSubset([partial], registry, vars, renderTemplate)).toEqual([]);
    }
  });

  test("unknown non-MCP names are reported; unknown MCP names are not", () => {
    const unknown: string[] = [];
    subagentToolSubset(
      ["not_a_tool", "mcp__nothing__here"],
      registry,
      vars,
      renderTemplate,
      undefined,
      (n) => unknown.push(n),
    );
    expect(unknown).toEqual(["not_a_tool"]);
  });

  test("descriptions are rendered with the agent's vars", () => {
    const custom: RegisteredTool[] = [
      { name: "read", description: "for {{char}}", parameters: {} },
    ];
    const [def] = subagentToolSubset(["read"], custom, vars, renderTemplate);
    expect(def?.description).toBe("for heidi");
  });

  test("parameters are carried through untouched", () => {
    const schema = { type: "object", properties: { path: { type: "string" } } };
    const custom: RegisteredTool[] = [{ name: "read", description: "d", parameters: schema }];
    const [def] = subagentToolSubset(["read"], custom, vars, renderTemplate);
    expect(def?.parameters).toEqual(schema);
  });
});

describe("templateVars", () => {
  const shape = fixture.template_vars as {
    keys: string[];
    char: string;
    character_name: string;
    user: string;
  };

  test("exposes exactly the documented keys", () => {
    const vars = templateVars("Heidi", "Eve");
    expect([...vars.keys()].sort()).toEqual(shape.keys);
    expect(vars.get("char")).toBe(shape.char);
    expect(vars.get("character_name")).toBe(shape.character_name);
    expect(vars.get("user")).toBe(shape.user);
  });

  test("date and time are populated from the live clock", () => {
    const vars = templateVars("Heidi", "Eve", () => new Date("2026-03-14T15:09:00Z"));
    expect(vars.get("date")).not.toBe("");
    expect(vars.get("time")).not.toBe("");
    const rendered = renderTemplate("Today is {{date}} at {{time}}.", vars);
    expect(rendered).not.toContain("{{date}}");
    expect(rendered).not.toContain("{{time}}");
  });
});

describe("missingModelMessage", () => {
  test("it names the character whose chat model there was nothing to inherit from", () => {
    expect(missingModelMessage("research", "ada")).toBe(
      "subagent 'research' has no model: subagents.research.model and defaults.subagent_model " +
        "are unset, and ada has no chat model to inherit",
    );
  });

  test("with no character attached it says so rather than naming one", () => {
    expect(missingModelMessage("research", undefined)).toContain(
      "no character is attached to inherit a chat model from",
    );
  });
});
