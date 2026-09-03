import { shoreLog } from "../log.ts";

import { randomUUID } from "node:crypto";

import {
  activeJsonlIn,
  characterDataDir,
  threadDataDir,
} from "../config/dirs.ts";

import type { LoadedConfig } from "../config/loader.ts";
import { configView, resolveChatModelForCharacter } from "../config/preferences.ts";
import { findEffectiveModel } from "../config/effective_catalog.ts";
import { MessageStore, isToolResultOnly } from "../engine/message_store.ts";
import type { Message } from "../engine/types.ts";
import { buildChatShapeRequestFromDisk } from "../handler/context.ts";
import type { BuiltRequest } from "../llm/request.ts";
import { segmentCount } from "../memory/compaction/archive.ts";
import { conversationRef } from "../engine/segments.ts";
import { homeThreadOf } from "../engine/threads.ts";
import type { McpRegistry } from "../tools/mcp_registry.ts";


export const IDLE_ANCHOR_TEXT =
  "[Resuming after an extended idle period — the earlier " +
  "conversation has been archived to memory.]";

export function historyIsBetweenTurns(messages: readonly Message[]): boolean {
  return messages.at(-1)?.role === "assistant";
}

export function heartbeatRebuildMessages(
  character: string,
  messages: readonly Message[],
  anchor: () => Message = () => idleAnchorMessage(),
): Message[] | undefined {
  const hasUserTurn = messages.some((m) => m.role === "user" && !isToolResultOnly(m));

  if (hasUserTurn) {
    if (!historyIsBetweenTurns(messages)) {
      shoreLog.info(
        `shore: heartbeat rebuild for ${character} skipped — the conversation is mid-turn`,
      );
      return undefined;
    }
    return [...messages];
  }

  if (messages.length > 0 && !historyIsBetweenTurns(messages)) {
    shoreLog.info(
      `shore: heartbeat rebuild for ${character} skipped — the conversation is mid-turn`,
    );
    return undefined;
  }

  shoreLog.info(
    `shore: heartbeat rebuild for ${character} — no live user turn, rebuilding from memory`,
  );
  return [anchor(), ...messages];
}

export function idleAnchorMessage(
  newId: () => string = () => `m_${randomUUID()}`,
  now: () => string = () => new Date().toISOString(),
): Message {
  return {
    msg_id: newId(),
    role: "user",
    content: IDLE_ANCHOR_TEXT,
    images: [],
    content_blocks: [{ type: "text", text: IDLE_ANCHOR_TEXT }],
    alternatives: [],
    timestamp: now(),
  };
}

export interface RebuildDeps {
  mcpRegistry?: Pick<McpRegistry, "toolDefsFiltered">;
  newId?: () => string;
  now?: () => string;
  timeZone?: string;
  thread?: string;
}

export async function rebuildRequestFromDisk(
  character: string,
  dataDir: string,
  config: LoadedConfig,
  deps: RebuildDeps = {},
): Promise<BuiltRequest | undefined> {
  const characterDir = characterDataDir(dataDir, character);
  const thread = deps.thread ?? (await homeThreadOf(dataDir, character));
  const conversationDir = threadDataDir(dataDir, character, thread);

  let store: MessageStore;
  try {
    store = await MessageStore.load(activeJsonlIn(conversationDir));
  } catch (e) {
    shoreLog.warn(`shore: heartbeat rebuild for ${character} could not load messages: ${String(e)}`);
    return undefined;
  }

  const selected = heartbeatRebuildMessages(character, store.messages(), () =>
    idleAnchorMessage(
      deps.newId ?? (() => `m_${randomUUID()}`),
      deps.now ?? (() => new Date().toISOString()),
    ),
  );
  if (selected === undefined) return undefined;

  const resolved = resolveChatModelForCharacter(configView(config), character, (v, c, n, h) =>
    findEffectiveModel(v, c, n, h),
  );
  if (resolved === undefined) return undefined;

  const hasPriorContext = (await segmentCount(conversationRef(dataDir, character, thread, false))) > 0;
  const mcpToolDefs = deps.mcpRegistry?.toolDefsFiltered(config.app.tools.enabled_tools) ?? [];

  try {
    const built = await buildChatShapeRequestFromDisk(
      character,
      characterDir,
      config,
      resolved,
      selected,
      hasPriorContext,
      {
        mcpToolDefs,
        activeConversation: store.messageCount() > 0,
        ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
      },
    );
    shoreLog.info(`shore: heartbeat rebuilt the request for ${character} from disk`);
    return built;
  } catch (e) {
    shoreLog.warn(`shore: heartbeat rebuild for ${character} failed: ${String(e)}`);
    return undefined;
  }
}
