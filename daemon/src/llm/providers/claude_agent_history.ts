import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock } from "../../engine/types.ts";
import { withStorage, ensureCollection, collectionText, appendCollection } from "../../storage/store.ts";
import type { SidecarRequest } from "../types.ts";
import { ToolNames } from "./claude_agent_tools.ts";
import { sessionKeyOwner } from "./agent_sessions.ts";
import { prepareImageBlocks } from "../prepare_images.ts";

function modelIdentityOf(entry: SessionStoreEntry): string | undefined {
  const record = entry as { type?: unknown; attachment?: { type?: unknown; identity?: { modelId?: unknown } } };
  if (record.type !== "attachment" || record.attachment?.type !== "model") return undefined;
  const id = record.attachment.identity?.modelId;
  return typeof id === "string" ? id : "";
}

export function withoutStaleModelIdentity(entries: SessionStoreEntry[], model: string): SessionStoreEntry[] {
  const latest = entries.findLastIndex((entry) => modelIdentityOf(entry) !== undefined);
  const stale = (entry: SessionStoreEntry, index: number) => {
    const identity = modelIdentityOf(entry);
    return identity !== undefined && (index !== latest || identity !== model);
  };
  if (!entries.some(stale)) return entries;
  const parents = new Map<string, string | null>();
  const kept: SessionStoreEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const record = entry as { uuid?: string; parentUuid?: string | null };
    const parent = record.parentUuid ?? null;
    const resolved = parent === null ? null : parents.get(parent) ?? parent;
    if (stale(entry, index)) {
      if (record.uuid !== undefined) parents.set(record.uuid, resolved);
      continue;
    }
    kept.push(resolved === parent ? entry : { ...entry, parentUuid: resolved });
  }
  return kept;
}

export function nativeHistoryStore(book: string, conversation: string, model: string): SessionStore {
  const data = dirname(book);
  const character = sessionKeyOwner(conversation) ?? "";
  const prefix = `sdk_transcripts/${basename(book)}/${Buffer.from(character).toString("base64url")}/`;
  const pathOf = (key: SessionKey) => prefix + [key.sessionId, key.subpath ?? ""]
    .map((part) => Buffer.from(part).toString("base64url")).join("/");
  return {
    load: (key) => Promise.resolve(withStorage(data, (db) => db.transaction(() => {
      const path = pathOf(key);
      if (db.query("SELECT 1 FROM state_files WHERE path = ?1").get(path) === null) return null;
      ensureCollection(db, path, character, "array");
      return withoutStaleModelIdentity(JSON.parse(collectionText(db, path) ?? "[]") as SessionStoreEntry[], model);
    })())),
    append: (key, added) => {
      withStorage(data, (db) => db.transaction(() => {
        const path = pathOf(key);
        ensureCollection(db, path, character, "array");
        appendCollection(db, path, added.map(entry => ({ text: JSON.stringify(entry), ...(entry.uuid === undefined ? {} : { key: entry.uuid }) })));
      })());
      return Promise.resolve();
    },
  };
}

export async function seedNativeHistory(req: SidecarRequest, sessionStore: SessionStore): Promise<{
  sessionId: string;
  assistantUuids: Map<number, string>;
  sessionStore: SessionStore;
  promptContent: ContentBlock[];
}> {
  const current = req.messages.at(-1);
  if (current?.role !== "user") {
    throw new Error("Claude Agent SDK: native history must end with a user turn to continue.");
  }
  const sessionId = randomUUID();
  const assistantUuids = new Map<number, string>();
  const names = new ToolNames(req.tools ?? []);
  const timestamp = new Date().toISOString();
  let parentUuid: string | null = null;
  const entries: SessionStoreEntry[] = [];
  for (const [index, message] of req.messages.slice(0, -1).entries()) {
    const uuid = randomUUID();
    const content = (await prepareImageBlocks(message.content)).map((block) => block.type === "tool_use"
      ? { ...block, name: names.wireOf(block.name) ?? block.name } : block);
    const entry: SessionStoreEntry = {
      type: message.role,
      uuid,
      parentUuid,
      sessionId,
      timestamp,
      cwd: req.context?.workspace_dir ?? tmpdir(),
      isSidechain: false,
      userType: "external",
      message: {
        role: message.role,
        content,
        ...(message.role === "assistant" ? {
          id: `msg_${uuid}`,
          type: "message",
          model: message.model ?? req.model,
          stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        } : {}),
      },
    };
    if (message.role === "assistant") assistantUuids.set(index, uuid);
    parentUuid = uuid;
    entries.push(entry);
  }
  await sessionStore.append({ projectKey: "", sessionId }, entries);
  return {
    sessionId,
    assistantUuids,
    promptContent: current.content,
    sessionStore,
  };
}
