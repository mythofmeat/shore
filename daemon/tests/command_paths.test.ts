import { expect, spyOn, test } from "bun:test";

import { TurnAutonomyBridge } from "../src/autonomy/registration.ts";
import * as registry from "../src/commands/registry.ts";
import type { CommandOperationContext } from "../src/commands/registry.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { dispatchCommand } from "../src/handler/commands.ts";
import { buildCommandPathDeps } from "../src/handler/deps.ts";
import type { GenerateResponse, SidecarProvider, SidecarRequest } from "../src/llm/types.ts";
import type { ServerMessage } from "../src/protocol/ServerMessage.ts";
import type { ShoreRuntime } from "../src/runtime.ts";
import { DEFAULT_HANDSHAKE } from "../src/swp/handshake.ts";
import { SessionRouter, type SessionMeta } from "../src/swp/session.ts";
import { afterFirstChat } from "./support/chat_world.ts";
import { eventsForResponse } from "./support/stream.ts";

const KEY_ENV = "SHORE_TEST_COMMAND_PATHS_KEY";

function provider(): SidecarProvider {
  const answer = async (request: SidecarRequest): Promise<GenerateResponse> => await Promise.resolve({
    model: request.model, content: "The lamp is lit.", content_blocks: [{ type: "text", text: "The lamp is lit." }], finish_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, timing: { total_ms: 1, time_to_first_token_ms: 1 },
  });
  return { generate: answer, stream: async function* (request: SidecarRequest) { yield* eventsForResponse(await answer(request)); } };
}

type Dispatch = (name: string, args?: unknown, session?: Partial<SessionMeta>) => Promise<ServerMessage>;

async function world(run: (dispatch: Dispatch, runtime: ShoreRuntime) => Promise<void>): Promise<void> {
  await afterFirstChat({ name: "command-paths", keyEnv: KEY_ENV, provider: provider(), tools: ["read"] }, async ({ runtime }) => {
    const deps = buildCommandPathDeps({
      runtime, autonomy: new TurnAutonomyBridge(runtime.autonomy), diagnostics: new Diagnostics(), router: new SessionRouter(),
      handshake: DEFAULT_HANDSHAKE, providers: runtime.providers, env: { [KEY_ENV]: "fixture-key" },
    });
    const dispatch: Dispatch = async (name, args = {}, session = {}) => await dispatchCommand(deps, { name, args }, {
      session: { sessionId: 1, clientId: 1, clientType: "test", clientName: "test", capabilities: [], selectedCharacter: "ada", selectedThread: "main", ...session },
      rid: "r", kind: "command",
    });
    await run(dispatch, runtime);
  });
}

test("a registered operation's arguments are checked before anything runs", async () => {
  await world(async (dispatch) => {
    expect(await dispatch("status", { nope: 1 })).toEqual({ type: "error", rid: "r", code: "invalid_request", message: "arguments must NOT have additional properties" });
  });
});

test("listing models runs for the selected character, and for the daemon when none is selected", async () => {
  await world(async (dispatch) => {
    const source = async (selectedCharacter: string | null) => {
      const frame = await dispatch("list_models", {}, { selectedCharacter });
      return frame.type === "command_output" ? (frame.data as { roles: { role: string; source: string }[] }).roles.find((role) => role.role === "chat")?.source : frame.type;
    };
    expect([await source("ada"), await source(null)]).toEqual(["character", "chat.model"]);
  });
});

test("switching character answers with the switch, and a character that doesn't exist is named in the refusal", async () => {
  await world(async (dispatch) => {
    expect(await dispatch("switch_character", { name: "ada" })).toEqual({ type: "command_output", rid: "r", name: "switch_character", data: { character: "ada", changed: false, selected_character: "ada", active_model: null } });
    expect(await dispatch("status", {}, { selectedCharacter: "nobody" })).toEqual({ type: "error", rid: "r", code: "invalid_request", message: 'character "nobody" not found (available: ["ada"])' });
  });
});

test("a conversation that won't open fails as the daemon's own error, unless the command can do without a character", async () => {
  await world(async (dispatch, runtime) => {
    const opening = spyOn(runtime.registry, "getOrCreate").mockImplementation(async () => { await Promise.resolve(); throw new Error("the history is locked"); });
    try {
      expect(await dispatch("status")).toEqual({ type: "error", rid: "r", code: "internal_error", message: "the history is locked" });
      expect((await dispatch("usage")).type).toBe("command_output");
    } finally { opening.mockRestore(); }
  });
});

test("a result that breaks its operation's contract is refused, with a character or without", async () => {
  await world(async (dispatch) => {
    const running = spyOn(registry, "runRegisteredOperation").mockImplementation(async () => await Promise.resolve({ bogus: true } as never));
    try {
      for (const [name, selectedCharacter] of [["status", "ada"], ["list_providers", null]] as const) {
        const frame = await dispatch(name, {}, { selectedCharacter });
        expect([frame.type, frame.type === "error" && frame.message.startsWith(`Invalid result for ${name}`)]).toEqual(["error", true]);
      }
    } finally { running.mockRestore(); }
  });
});

test("an archive command is handed its device as owner and the session's archive limits, and a command without a character the daemon's environment", async () => {
  await world(async (dispatch) => {
    const handed: CommandOperationContext[] = [];
    const running = spyOn(registry, "runRegisteredOperation").mockImplementation((_name, context) => { handed.push(context); throw new Error("stop here"); });
    try {
      await dispatch("export_character", { character: "ada" }, { owner: "device-1", archiveLimits: { bytes: 5, entries: 2 } });
      await dispatch("export_character", { character: "ada" });
      await dispatch("list_providers", {}, { selectedCharacter: null });
    } finally { running.mockRestore(); }
    expect(handed.slice(0, 2).map((context) => [context.deps.archive?.owner, context.deps.archive?.limits])).toEqual([["device-1", { bytes: 5, entries: 2 }], ["session-1", undefined]]);
    expect(handed.at(-1)?.session.env).toEqual({ [KEY_ENV]: "fixture-key" });
  });
});
