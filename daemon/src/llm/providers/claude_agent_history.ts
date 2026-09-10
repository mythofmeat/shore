import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock } from "../../engine/types.ts";
import { pack, unpack, withStorage } from "../../storage/store.ts";
import type { SidecarRequest } from "../types.ts";
import { ToolNames } from "./claude_agent_tools.ts";
import { sessionKeyOwner } from "./agent_sessions.ts";

export function nativeHistoryStore(book: string, conversation: string): SessionStore {
  const data = dirname(book);
  const character = sessionKeyOwner(conversation) ?? "";
  const prefix = `sdk_transcripts/${basename(book)}/${Buffer.from(character).toString("base64url")}/`;
  const pathOf = (key: SessionKey) => prefix + [key.sessionId, key.subpath ?? ""]
    .map((part) => Buffer.from(part).toString("base64url")).join("/");
  const load = (key: SessionKey): SessionStoreEntry[] | null => {
    return withStorage(data, (db) => {
      const row = db.query("SELECT content FROM state_files WHERE path = ?1").get(pathOf(key)) as { content: Uint8Array } | null;
      return row === null ? null : JSON.parse(unpack(row.content)) as SessionStoreEntry[];
    });
  };
  return {
    load: (key) => Promise.resolve(load(key)),
    append: (key, added) => {
      withStorage(data, (db) => db.transaction(() => {
        const row = db.query("SELECT content FROM state_files WHERE path = ?1").get(pathOf(key)) as { content: Uint8Array } | null;
        const entries = row === null ? [] : JSON.parse(unpack(row.content)) as SessionStoreEntry[];
        const positions = new Map(entries.flatMap((entry, index) => entry.uuid === undefined ? [] : [[entry.uuid, index] as const]));
        for (const entry of added) {
          const index = entry.uuid === undefined ? undefined : positions.get(entry.uuid);
          if (index === undefined) {
            if (entry.uuid !== undefined) positions.set(entry.uuid, entries.length);
            entries.push(entry);
          } else entries[index] = entry;
        }
        db.query(`INSERT INTO state_files(path, character, content) VALUES (?1, ?2, ?3)
          ON CONFLICT(path) DO UPDATE SET content = excluded.content`).run(pathOf(key), character, pack(JSON.stringify(entries)));
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
  const entries: SessionStoreEntry[] = req.messages.slice(0, -1).map((message, index) => {
    const uuid = randomUUID();
    const content = message.content.map((block) => block.type === "tool_use"
      ? { ...block, name: names.wireOf(block.name) ?? block.name } : block);
    const entry: SessionStoreEntry = {
      type: message.role,
      uuid,
      parentUuid,
      sessionId,
      timestamp,
      cwd: tmpdir(),
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
    return entry;
  });
  await sessionStore.append({ projectKey: "", sessionId }, entries);
  return {
    sessionId,
    assistantUuids,
    promptContent: current.content,
    sessionStore,
  };
}
