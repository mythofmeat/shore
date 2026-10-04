import type { ConversationEngine } from "../engine/conversation.ts";
import type { CommandSession, CommandDeps } from "./dispatch.ts";
import type { StatusContext } from "./status.ts";
import { effectiveChatModel } from "./models.ts";
import { conversationTokens } from "../ledger/conversation_spend.ts";
import { estimateHistoryTokens } from "../engine/prompt.ts";
import { imageTierForModel } from "../llm/image_tokens.ts";
import { localWallClock } from "../autonomy/activity.ts";

export function statusContext(
  engine: ConversationEngine,
  session: CommandSession,
  deps: CommandDeps,
): StatusContext {
  const model = effectiveChatModel(session.config, engine.characterName, session.threadModel);
  return {
    thread: engine.thread,
    characterName: engine.characterName,
    turnCount: engine.turnCount(),
    activeModel: model?.qualifiedName,
    config: { app: { defaults: { model: session.config.app.defaults.model } }, dirs: session.config.dirs },
    conversationTokens: conversationTokens(
      deps.ledgerPath,
      engine.characterName,
      engine.startedAt(),
    ),
    contextTokens: estimateHistoryTokens(
      engine.messages(),
      model === undefined ? undefined : imageTierForModel(model.modelId),
    ),
    autonomy: deps.autonomy,
    diagnostics: deps.diagnostics,
    now: deps.now ?? Date.now,
    localNow: deps.localNow ?? (() => localWallClock(Date.now())),
    workspaceIndex:
      deps.workspaceIndex === undefined
        ? undefined
        : { ...deps.workspaceIndex, ...(deps.now === undefined ? {} : { now: deps.now }) },
    historyIndex:
      deps.historyIndex === undefined
        ? undefined
        : { ...deps.historyIndex, ...(deps.now === undefined ? {} : { now: deps.now }) },
    ...(deps.mcpStatus === undefined ? {} : { mcpServers: deps.mcpStatus() }),
    ...(deps.running === undefined ? {} : { running: deps.running() }),
  };
}
