import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlock } from "../../engine/types.ts";
import { withStorage, ensureCollection, collectionText, appendCollection } from "../../storage/store.ts";
import { imageBlobs, imageCacheFor, withImageData, withImageReferences } from "../../storage/image_blobs.ts";
import type { SidecarRequest } from "../types.ts";
import { ToolNames } from "./claude_agent_tools.ts";
import { sessionKeyOwner } from "./agent_sessions.ts";
import { limitImageBlocks } from "../prepare_images.ts";
import { MANY_IMAGES_MAX_EDGE } from "../image_settings.ts";

export function nativeHistoryStore(book: string, conversation: string): SessionStore {
  const data = dirname(book);
  const character = sessionKeyOwner(conversation) ?? "";
  const prefix = `sdk_transcripts/${basename(book)}/${Buffer.from(character).toString("base64url")}/`;
  const pathOf = (key: SessionKey) => prefix + [key.sessionId, key.subpath ?? ""]
    .map((part) => Buffer.from(part).toString("base64url")).join("/");
  const cache = imageCacheFor(data);
  const blobs = cache === undefined ? undefined : imageBlobs(cache, character, true);
  return {
    load: (key) => Promise.resolve(withStorage(data, (db) => db.transaction(() => {
      const path = pathOf(key);
      if (db.query("SELECT 1 FROM state_files WHERE path = ?1").get(path) === null) return null;
      ensureCollection(db, path, character, "array");
      const entries = JSON.parse(collectionText(db, path) ?? "[]") as SessionStoreEntry[];
      return withImageData(entries, blobs);
    })())),
    append: (key, added) => {
      const stored = blobs === undefined ? added : added.map((entry) => withImageReferences(entry, blobs));
      withStorage(data, (db) => db.transaction(() => {
        const path = pathOf(key);
        ensureCollection(db, path, character, "array");
        appendCollection(db, path, stored.map(entry => ({ text: JSON.stringify(entry), ...(entry.uuid === undefined ? {} : { key: entry.uuid }) })));
      })());
      return Promise.resolve();
    },
  };
}

export function throwawayHistoryStore(): SessionStore {
  const sessions = new Map<string, SessionStoreEntry[]>();
  const pathOf = (key: SessionKey) => `${key.sessionId}/${key.subpath ?? ""}`;
  return {
    load: (key) => Promise.resolve(sessions.get(pathOf(key)) ?? null),
    append: (key, added) => {
      sessions.set(pathOf(key), [...(sessions.get(pathOf(key)) ?? []), ...added]);
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
    const content = (await limitImageBlocks(message.content, MANY_IMAGES_MAX_EDGE)).map((block) => block.type === "tool_use"
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
