import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import fixture from "./commands_fixtures/conversation.json" with { type: "json" };

import {
  alt,
  deleteMessages,
  edit,
  get,
  historyPage,
  injectSystem,
  listAlternatives,
  log,
  resolveRef,
} from "../src/commands/conversation.ts";
import { CommandError } from "../src/commands/errors.ts";
import { ConversationEngine } from "../src/engine/conversation.ts";
import type { Message } from "../src/engine/types.ts";
import { testTmp } from "./support/tmp.ts";

interface WireError {
  code: string;
  message: string;
}

interface RefCase {
  name: string;
  note?: string;
  messages: Message[];
  ref: string;
  ok?: string;
  err?: WireError;
}

interface Step {
  op: string;
  args: Record<string, unknown>;
  history_pushes: number;
  ok?: unknown;
  err?: WireError;
  engine_after?: Message[];
}

interface Scenario {
  name: string;
  note?: string;
  archived: Message[];
  active: Message[];
  files: { name: string; bytes_utf8: string }[];
  initial_messages: Message[];
  initial_display_history: Message[];
  steps: Step[];
}

const refCases = fixture.resolve_ref as unknown as RefCase[];
const scenarios = fixture.scenarios as unknown as Scenario[];

function isMessage(v: Record<string, unknown>): boolean {
  return "msg_id" in v && "role" in v && "content_blocks" in v;
}

function serdeShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serdeShape);
  if (value === null || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const message = isMessage(input);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (message && key === "alternatives" && Array.isArray(v) && v.length === 0) continue;
    out[key] = serdeShape(v);
  }
  return out;
}

const UUID_RE = /^m_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

const STUB_ID = "m_00000000-0000-4000-8000-000000000000";
const STUB_NOW = "2026-01-02T03:04:05.678+00:00";

async function buildScenario(
  scenario: Scenario,
): Promise<{ engine: ConversationEngine; pushes: () => number; root: string }> {
  const root = await mkdtemp(testTmp("shore-conv-"));
  const characterDir = join(root, "TestChar");
  await mkdir(characterDir, { recursive: true });

  for (const file of scenario.files) {
    await writeFile(join(root, file.name), file.bytes_utf8);
  }

  const substitute = (messages: Message[]): Message[] =>
    JSON.parse(JSON.stringify(messages).replaceAll("<tmp>", root)) as Message[];
  const jsonl = (messages: Message[]) =>
    messages.map((m) => JSON.stringify(m)).join("\n") + "\n";

  const active = substitute(scenario.active);
  if (scenario.archived.length > 0) {
    const archived = substitute(scenario.archived);
    await mkdir(join(characterDir, "segments"), { recursive: true });
    await writeFile(join(characterDir, "segments", "0001.jsonl"), jsonl(archived));
    await writeFile(
      join(characterDir, "compaction.json"),
      JSON.stringify(
        {
          segments: [
            {
              file: "0001.jsonl",
              message_count: archived.length,
              compacted_at: "2026-01-01T00:00:00Z",
            },
          ],
          total_compacted_messages: archived.length,
        },
        null,
        2,
      ),
    );
  }
  await writeFile(join(characterDir, "active.jsonl"), jsonl(active));

  let count = 0;
  const engine = await ConversationEngine.load("TestChar", root, () => {
    count += 1;
  });
  return { engine, pushes: () => count, root };
}

function expand(value: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll("<tmp>", root)) as unknown;
}

function remask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(remask);
  if (value === null || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(input)) {
    if (key === "msg_id" && v === STUB_ID) out[key] = "<uuid>";
    else if (key === "timestamp" && v === STUB_NOW) out[key] = "<local-now>";
    else out[key] = remask(v);
  }
  return out;
}

async function runStep(engine: ConversationEngine, step: Step): Promise<unknown> {
  const args = step.args;
  switch (step.op) {
    case "get":
      return get(engine, args);
    case "log":
      return await log(engine, args);
    case "history_page":
      return await historyPage(engine, args);
    case "list_alternatives":
      return listAlternatives(engine, args);
    case "edit":
      return await edit(engine, args);
    case "delete":
      return await deleteMessages(engine, args);
    case "alt":
      return await alt(engine, args);
    case "inject_system":
      return await injectSystem(
        engine,
        args,
        () => STUB_ID,
        () => STUB_NOW,
      );
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

describe("resolveRef", () => {
  for (const c of refCases) {
    test(c.name, () => {
      if (c.err !== undefined) {
        let thrown: unknown;
        try {
          resolveRef(c.messages, c.ref);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(CommandError);
        expect((thrown as CommandError).code).toBe(c.err.code as never);
        expect((thrown as CommandError).message).toBe(c.err.message);
      } else {
        expect(resolveRef(c.messages, c.ref)).toBe(c.ok!);
      }
    });
  }
});

describe("resolveRef rejects what Rust's integer parse rejects", () => {
  const messages: Message[] = [
    { msg_id: "m1", role: "user", content: "A", images: [], content_blocks: [], timestamp: "t" },
    { msg_id: "m2", role: "user", content: "B", images: [], content_blocks: [], timestamp: "t" },
  ];
  for (const literal of ["1.5", " 2", "2 ", "1e1", "0x2", "２", "", "1_0", "Infinity"]) {
    test(`${JSON.stringify(literal)} is a literal, not an index`, () => {
      expect(resolveRef(messages, literal)).toBe(literal);
    });
  }
  test("a value past i64 is a literal, not a saturated index", () => {
    expect(resolveRef(messages, "99999999999999999999")).toBe("99999999999999999999");
  });
});

describe("conversation commands", () => {
  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const { engine, pushes, root } = await buildScenario(scenario);

      expect(serdeShape(engine.messages())).toEqual(
        expand(scenario.initial_messages, root) as never,
      );
      const display = await engine.displayHistory();
      expect(serdeShape(display.messages)).toEqual(
        expand(scenario.initial_display_history, root) as never,
      );

      let seen = pushes();
      for (const step of scenario.steps) {
        const label = `${step.op} ${JSON.stringify(step.args)}`;
        let result: unknown;
        let thrown: unknown;
        try {
          result = await runStep(engine, step);
        } catch (e) {
          thrown = e;
        }

        if (step.err !== undefined) {
          expect(thrown, label).toBeInstanceOf(CommandError);
          expect((thrown as CommandError).code, label).toBe(step.err.code as never);
          expect((thrown as CommandError).message, label).toBe(step.err.message);
        } else {
          expect(thrown, label).toBeUndefined();
          expect(remask(serdeShape(result)), label).toEqual(
            remask(expand(step.ok, root)) as never,
          );
        }

        expect(pushes() - seen, `${label} — history pushes`).toBe(step.history_pushes);
        seen = pushes();

        if (step.engine_after !== undefined) {
          expect(remask(serdeShape(engine.messages())), `${label} — engine after`).toEqual(
            remask(expand(step.engine_after, root)) as never,
          );
        }
      }
    });
  }
});

describe("injectSystem generates a uuid and a local timestamp", () => {
  test("the defaults produce the shapes the fixture masked", async () => {
    const { engine } = await buildScenario(
      scenarios.find((s) => s.name === "inject_system")!,
    );
    await injectSystem(engine, { text: "hello" });
    const appended = engine.messages()[engine.messages().length - 1]!;
    expect(appended.msg_id).toMatch(UUID_RE);
    expect(appended.timestamp).toMatch(LOCAL_RFC3339_RE);
    expect(Number.isNaN(Date.parse(appended.timestamp))).toBe(false);
  });
});
