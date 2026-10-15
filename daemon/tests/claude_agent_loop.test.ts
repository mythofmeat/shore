import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeAgentToolLoopEvents } from "../src/llm/providers/claude_agent.ts";
import { fakeAgent, type FakeScript } from "../src/testing/fake_agent_query.ts";
import type { ToolPhase } from "../src/tools/execute.ts";
import type { ToolUseEvent } from "../src/engine/tool_loop.ts";
import type { ContentBlock, Message, Role } from "../src/engine/types.ts";
import type { SidecarRequest, StreamEvent, ToolDefinition } from "../src/llm/types.ts";

const SCHEMA: Record<string, unknown> = { type: "object" };

function def(name: string): ToolDefinition {
  return { name, description: `the ${name} tool`, input_schema: SCHEMA };
}

interface Recorded {
  role: Role;
  blocks: ContentBlock[];
}

interface Phase extends ToolPhase {
  dispatched: ToolUseEvent[];
  recorded: Recorded[];
}

function phase(output: (use: ToolUseEvent) => string = () => "ok"): Phase {
  const dispatched: ToolUseEvent[] = [];
  const recorded: Recorded[] = [];
  const messages: Message[] = [];
  return {
    messages,
    dispatched,
    recorded,
    runTool: (use) => {
      dispatched.push(use);
      return Promise.resolve({
        type: "tool_result",
        tool_use_id: use.id,
        content: output(use),
      } satisfies ContentBlock);
    },
    recordTurn: (role, blocks) => {
      recorded.push({ role, blocks });
    },
  };
}

function request(overrides: Partial<SidecarRequest> = {}): SidecarRequest {
  return {
    sdk: "claude_agent",
    model: "claude-opus-5",
    api_key: "",
    messages: [{ role: "user", content: [{ type: "text", text: "read SOUL.md" }] }],
    max_tokens: 4096,
    replay_prior_thinking: "all",
    tools: [def("read"), def("ask_internet")],
    ...overrides,
  };
}

async function drive(
  script: FakeScript,
  tools: Phase,
  req: SidecarRequest = request(),
): Promise<{ events: StreamEvent[]; agent: ReturnType<typeof fakeAgent>; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "shore-agent-loop-"));
  const path = join(dir, "sessions.json");
  const agent = fakeAgent(script);
  const events: StreamEvent[] = [];
  const stream = claudeAgentToolLoopEvents(req, tools, undefined, {
    runQuery: agent.query,
    bookPath: () => path,
  });
  for await (const event of stream) events.push(event);
  return { events, agent, path };
}

function done(events: readonly StreamEvent[]): Extract<StreamEvent, { type: "done" }> {
  const found = events.find((e) => e.type === "done");
  if (found === undefined) throw new Error("no done event");
  return found;
}

describe("the tool budget", () => {
  test("a spent budget stops further calls but still lets the turn answer", async () => {
    const tools = phase();
    const { events, agent } = await drive(
      {
        rounds: [
          { blocks: [], toolCalls: [{ name: "read" }] },
          { blocks: [], toolCalls: [{ name: "read" }] },
          { blocks: [{ kind: "text", text: "what I have is enough" }] },
        ],
      },
      tools,
      request({ max_tool_iterations: 1 }),
    );
    expect(tools.dispatched).toHaveLength(1);
    expect(agent.toolOutcomes[1]?.allowed).toBe(false);
    expect(agent.toolOutcomes[1]?.denial).toContain("tool budget");
    expect(done(events).content).toBe("what I have is enough");
  });

  test("a tool shore never advertised is refused before it is dispatched", async () => {
    const tools = phase();
    const { agent } = await drive(
      {
        rounds: [
          { blocks: [], toolCalls: [{ name: "rm" }] },
          { blocks: [{ kind: "text", text: "not allowed" }] },
        ],
      },
      tools,
    );
    expect(tools.dispatched).toHaveLength(0);
    expect(agent.toolOutcomes[0]?.allowed).toBe(false);
  });
});
