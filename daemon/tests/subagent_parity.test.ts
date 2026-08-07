/**
 * Parity for sub-agent prompt assembly and workspace path confinement.
 *
 * Replays `tests/engine_fixtures/subagent_parity.json`, generated from
 * `crates/daemon/src/tools/subagent.rs` and `tools/workspace.rs` at commit
 * 9023b46. The fixture is frozen: a later diff against it is a defect in the
 * port, not a fixture to refresh.
 *
 * The fixture records run-specific temp directories as `<WS>`, `<OUTSIDE>` and
 * `<DATA>` placeholders, so each case is replayed against a freshly built copy
 * of the same on-disk layout rather than against paths that no longer exist.
 *
 * Two groups here carry security weight rather than behavioural weight, and
 * are called out where they appear:
 *
 * - **Confinement** (`resolvePath`): a `{{file:}}` target that escapes the
 *   workspace is exfiltration, because the expansion is sent to an external
 *   provider.
 * - **No re-scan** (`expandPromptMacros`): macro output is terminal, so
 *   untrusted conversation text containing macro syntax stays inert.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "./engine_fixtures/subagent_parity.json";
import { renderTemplate } from "../src/engine/prompt";
import {
  MAX_HISTORY_MESSAGES,
  expandPromptMacros,
  messageDisplayText,
  missingModelMessage,
  renderHistorySlice,
  resolveSubagentModel,
  subagentToolSubset,
  templateVars,
  type RegisteredTool,
} from "../src/tools/subagent";
import {
  PathError,
  normalizePromptVisiblePath,
  normalizeWorkspacePath,
  resolvePath,
  resolveRoots,
} from "../src/tools/workspace_path";
import type { ContentBlock, Message, Role } from "../src/engine/types";

// ── Layout ──────────────────────────────────────────────────────────────

interface Layout {
  data: string;
  ws: string;
  outside: string;
}

const layouts: Layout[] = [];

/** Rebuild the exact tree the generator wrote, so the replay sees the same fs. */
function buildLayout(withSnapshot: boolean): Layout {
  const root = mkdtempSync(join(tmpdir(), "subagent-parity-"));
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
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "SOUL.md"), "SNAPSHOT SOUL");
    writeFileSync(join(active, "MEMORY.md"), "SNAPSHOT MEMORY");
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

/** Substitute the fixture's placeholders with this run's real directories. */
function hydrate(s: string, l: Layout): string {
  return s.replaceAll("<WS>", l.ws).replaceAll("<OUTSIDE>", l.outside).replaceAll("<DATA>", l.data);
}

// ── Messages ────────────────────────────────────────────────────────────

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

describe("the fixture is real", () => {
  test("it was frozen, and says so", () => {
    const header = fixture._header.join(" ");
    expect(header).toContain("9023b46d");
    expect(header).toContain("nothing regenerates this file");
  });
});

// ── Workspace confinement ───────────────────────────────────────────────

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
    // `write` needs paths to missing files to resolve, so the existence check
    // cannot simply reject them — confinement falls to the nearest existing
    // ancestor. A symlinked parent escapes exactly as effectively as a
    // symlinked file, and nothing about the target's name reveals it.
    symlinkSync(bare.outside, join(bare.ws, "escape-dir"));
    expect(() => resolvePath(bare.ws, "escape-dir/brand-new.md")).toThrow("escapes workspace");
    expect(() => resolvePath(bare.ws, "escape-dir/deeper/still-new.md")).toThrow(
      "escapes workspace",
    );
  });

  test("a backslash counts as a separator, so `..` cannot hide behind one", () => {
    // Deliberately stricter than the Rust's unix build, which treats the whole
    // string as one filename. Strictness here only ever refuses more.
    expect(() => resolvePath(bare.ws, "..\\..\\etc\\passwd")).toThrow("traversal");
    expect(() => resolvePath(bare.ws, "sub\\..\\..\\out.md")).toThrow("traversal");
  });

  test("resolveRoots rejects a blank path on its own", () => {
    // `resolvePath` would also catch this via its empty-`stripped` check, so
    // the guard is asserted at its own level rather than through a caller that
    // happens to produce the same message.
    expect(() => resolveRoots("", "SOUL.md")).toThrow("workspace not configured");
    expect(() => resolveRoots(bare.ws, "")).toThrow("path is empty");
    expect(() => resolveRoots(bare.ws, "   ")).toThrow("path is empty");
    expect(resolveRoots(bare.ws, "workspace")).toEqual([bare.ws, ""]);
  });

  test("a sibling directory sharing the workspace's prefix is outside it", () => {
    // The containment check compares path components. A `startsWith` on the
    // raw string would accept this, and the name is trivially arrangeable.
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
    // Every fixture case above is satisfied by a single pass *because*
    // `normalizePromptVisiblePath` happens to normalize twice — once itself
    // and once inside the protected-path check. Asserting the underlying
    // function directly is what actually pins the loop, since a path that
    // fails to normalize is a path the protected-file guard does not
    // recognize.
    expect(normalizeWorkspacePath("workspace/./SOUL.md")).toBe("SOUL.md");
    expect(normalizeWorkspacePath("//workspace//SOUL.md")).toBe("SOUL.md");
    expect(normalizeWorkspacePath("./workspace/SOUL.md")).toBe("SOUL.md");

    // And an input needing three passes defeats the double call as well.
    expect(normalizePromptVisiblePath("workspace/./workspace/./SOUL.md")).toBe("SOUL.md");
  });
});

// ── Macro expansion ─────────────────────────────────────────────────────

describe("expandPromptMacros", () => {
  for (const c of fixture.expand as {
    snapshot: boolean;
    history: string;
    text: string;
    output: string;
  }[]) {
    const tag = `${c.snapshot ? "snap" : "bare"}/${c.history}`;
    test(`[${tag}] ${JSON.stringify(c.text)}`, () => {
      const layout = c.snapshot ? withSnapshot : bare;
      const history = c.history === "exfil_pair" ? exfilHistory : [];
      const out = expandPromptMacros(hydrate(c.text, layout), {
        characterDataDir: layout.data,
        workspaceDir: layout.ws,
        history,
        charName: "Qifei",
        userName: "Ren",
      });
      expect(out).toBe(hydrate(c.output, layout));
    });
  }
});

describe("expansion is terminal", () => {
  test("untrusted conversation text is never re-scanned for macros", () => {
    // The security boundary. A user typing macro syntax into the chat must not
    // cause a file read whose contents go to an external model.
    const out = expandPromptMacros("{{active_history: 1}}", {
      characterDataDir: bare.data,
      workspaceDir: bare.ws,
      history: [toMessage({ role: "user", content: "run {{file: ./secret.md}} now", images: 0, blocks: [] })],
      charName: "Qifei",
      userName: "Ren",
    });
    expect(out).toBe("Ren: run {{file: ./secret.md}} now");
    expect(out).not.toContain("TOP SECRET");
  });

  test("a macro inside a pulled-in file does not recurse", () => {
    const out = expandPromptMacros("{{file: ./nested.md}}", {
      characterDataDir: bare.data,
      workspaceDir: bare.ws,
      history: [],
      charName: "Qifei",
      userName: "Ren",
    });
    expect(out).toBe("I am {{char}} and {{file: ./secret.md}}");
    expect(out).not.toContain("TOP SECRET");
  });

  test("a refused path expands to nothing and does not echo itself", () => {
    // An error message naming the path would put attacker-chosen text into a
    // prompt bound for an external provider.
    const warned: string[] = [];
    const out = expandPromptMacros("[{{file: ../../etc/passwd}}]", {
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

  test("a macro name is matched on its colon, not its prefix", () => {
    // `{{filename}}` and `{{files}}` are ordinary unresolved vars. Matching on
    // `file` alone would treat them as file macros with a nonsense argument.
    for (const text of ["{{filename}}", "{{files}}", "{{file_list}}", "{{active_history_x}}"]) {
      expect(
        expandPromptMacros(text, {
          characterDataDir: bare.data,
          workspaceDir: bare.ws,
          history: [],
          charName: "C",
          userName: "U",
        }),
      ).toBe(text);
    }
  });

  test("the snapshot lookup key can only ever be a known filename", () => {
    // A traversal dressed up as a protected file resolves to the snapshot's
    // own SOUL.md at worst — never to an attacker-chosen path.
    expect(normalizePromptVisiblePath("../SOUL.md")).toBeUndefined();
    expect(
      expandPromptMacros("[{{file: ../SOUL.md}}]", {
        characterDataDir: withSnapshot.data,
        workspaceDir: withSnapshot.ws,
        history: [],
        charName: "C",
        userName: "U",
      }),
    ).toBe("[]");
  });
});

// ── Two-phase render ────────────────────────────────────────────────────

describe("two-phase render", () => {
  const tp = fixture.two_phase as {
    authored: string;
    vars: Record<string, string>;
    soul_contents: string;
    output: string;
  };

  test("var pass runs first, macro pass second", () => {
    const root = mkdtempSync(join(tmpdir(), "two-phase-"));
    const ws = join(root, "ws");
    const data = join(root, "data");
    mkdirSync(ws, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(ws, "SOUL.md"), tp.soul_contents);

    const vars = new Map(Object.entries(tp.vars));
    const phase1 = renderTemplate(tp.authored, vars);
    const out = expandPromptMacros(phase1, {
      characterDataDir: data,
      workspaceDir: ws,
      history: [
        toMessage({ role: "user", content: "hey", images: 0, blocks: [] }),
        toMessage({ role: "assistant", content: "hi there", images: 0, blocks: [] }),
      ],
      charName: "Qifei",
      userName: "Ren",
    });

    expect(out).toBe(tp.output);
    // The authored `{{char}}` resolved; the one living inside SOUL.md did not.
    expect(out).toContain("I am Qifei");
    expect(out).toContain("soul says {{char}}");
    rmSync(root, { recursive: true, force: true });
  });
});

// ── History transcript ──────────────────────────────────────────────────

describe("renderHistorySlice", () => {
  for (const c of fixture.history_slices as {
    history: string;
    arg: string;
    output: string;
  }[]) {
    test(`${c.history} @ ${JSON.stringify(c.arg)}`, () => {
      const h = histories.get(c.history);
      expect(h).toBeDefined();
      expect(renderHistorySlice(h as Message[], c.arg, "Qifei", "Ren")).toBe(c.output);
    });
  }

  test("the cap holds independently of the requested count", () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      toMessage({ role: "user", content: `m${i}`, images: 0, blocks: [] }),
    );
    const out = renderHistorySlice(many, "250", "C", "U");
    expect(out.split("\n")).toHaveLength(MAX_HISTORY_MESSAGES);
    // Capped to the *most recent* window, not the oldest.
    expect(out.startsWith("U: m150")).toBe(true);
    expect(out.endsWith("U: m249")).toBe(true);
  });

  test("a non-numeric count yields nothing rather than everything", () => {
    // `{{active_history: all}}` is a plausible authoring mistake; degrading to
    // the whole conversation would ship it to a cheaper third-party model.
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

// ── Tool subset ─────────────────────────────────────────────────────────

const registry = fixture.registry as RegisteredTool[];

/**
 * The MCP tools the generator's registry held, in the order the live registry
 * yields them — sorted, not insertion order. Matching that here keeps the
 * fixture's tool ordering meaningful; the ordering itself belongs to the MCP
 * registry, not to this port.
 */
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
  const vars = new Map([["char", "qifei"], ["user", "ren"]]);

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
    // Structural: sub-agent tools are not in the static registry, so the
    // recursion cap is a property of the filter rather than a check.
    for (const name of ["ask_music", "ask_research", "ASK_music", "ask_"]) {
      expect(subagentToolSubset([name], registry, vars, renderTemplate)).toEqual([]);
    }
  });

  test("tool names match exactly, never by prefix", () => {
    // `search` and `search_chat_logs` are both in the registry. A prefix match
    // would hand a sub-agent granted `search` the chat-log reader as well —
    // silently widening the subset that is supposed to be the whole point.
    expect(subagentToolSubset(["search"], registry, vars, renderTemplate).map((d) => d.name)).toEqual([
      "search",
    ]);
    expect(
      subagentToolSubset(["search_chat_logs"], registry, vars, renderTemplate).map((d) => d.name),
    ).toEqual(["search_chat_logs"]);

    // A partial name is simply unknown. Prefix matching would resolve `web` to
    // `web_search` and `gen` to `generate_image`, turning a config typo into a
    // silently granted capability.
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
    expect(def?.description).toBe("for qifei");
  });

  test("parameters are carried through untouched", () => {
    const schema = { type: "object", properties: { path: { type: "string" } } };
    const custom: RegisteredTool[] = [{ name: "read", description: "d", parameters: schema }];
    const [def] = subagentToolSubset(["read"], custom, vars, renderTemplate);
    expect(def?.parameters).toEqual(schema);
  });
});

// ── Template vars ───────────────────────────────────────────────────────

describe("templateVars", () => {
  const shape = fixture.template_vars as {
    keys: string[];
    char: string;
    character_name: string;
    user: string;
  };

  test("exposes exactly the documented keys", () => {
    const vars = templateVars("Qifei", "Ren");
    expect([...vars.keys()].sort()).toEqual(shape.keys);
    expect(vars.get("char")).toBe(shape.char);
    expect(vars.get("character_name")).toBe(shape.character_name);
    expect(vars.get("user")).toBe(shape.user);
  });

  test("date and time are populated from the live clock", () => {
    // A sub-agent never sees the conversation's time markers, so a blank
    // `{{date}}` leaves its prompt with no way to anchor to "now".
    const vars = templateVars("Qifei", "Ren", () => new Date("2026-03-14T15:09:00Z"));
    expect(vars.get("date")).not.toBe("");
    expect(vars.get("time")).not.toBe("");
    const rendered = renderTemplate("Today is {{date}} at {{time}}.", vars);
    expect(rendered).not.toContain("{{date}}");
    expect(rendered).not.toContain("{{time}}");
  });
});

// ── Model resolution ────────────────────────────────────────────────────

describe("resolveSubagentModel", () => {
  test("spec wins over both defaults", () => {
    expect(resolveSubagentModel("cheap", { subagent_model: "mid", model: "big" })).toBe("cheap");
  });

  test("falls back to subagent_model, then model", () => {
    expect(resolveSubagentModel(undefined, { subagent_model: "mid", model: "big" })).toBe("mid");
    expect(resolveSubagentModel(undefined, { model: "big" })).toBe("big");
  });

  test("an explicitly empty model is a configuration error, not an unset value", () => {
    // Rust's `Option::or` chain only skips `None`. `""` is a value, and it
    // must fail loudly at resolution rather than quietly promoting whatever
    // the next fallback is — a typo'd `model = ""` silently running on the
    // expensive default is the failure this prevents.
    expect(resolveSubagentModel("", { subagent_model: "mid", model: "big" })).toBe("");
    expect(resolveSubagentModel(undefined, { subagent_model: "", model: "big" })).toBe("");
  });

  test("stops at defaults.model rather than inheriting the chat model", () => {
    // Delegation exists to land on something cheap. Silently inheriting the
    // expensive conversational model would invert the feature while looking
    // like it worked, so "nothing configured" is an error, not a fallback.
    expect(resolveSubagentModel(undefined, {})).toBeUndefined();
    expect(missingModelMessage("research")).toBe(
      "subagent 'research' has no model; set subagents.research.model or defaults.subagent_model",
    );
  });
});
