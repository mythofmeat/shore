import { mkdir } from "node:fs/promises";

import { characterDataDir, threadDataDir } from "../config/dirs.ts";
import { keepSealedThreads, sealedThreads, type SealedThread } from "./sealed_list.ts";
import { assertThreadId, createThread, ensureThreads, readThreadsIndex, startReadMarkBefore, ThreadError, threadRecord, type ThreadsIndex } from "./threads.ts";

export interface NewSealedThread {
  id: string;
  label: string;
  unsealAt: number;
}

export async function sealThread(data: string, character: string, request: NewSealedThread, now: number): Promise<SealedThread> {
  assertThreadId(request.id);
  const label = request.label.trim();
  if (label === "") throw new ThreadError("invalid_seal", "a sealed thread needs a label, which is all your other threads see of it");
  if (!(request.unsealAt > now)) throw new ThreadError("invalid_seal", "a sealed thread has to open at a time that is still to come");
  const characterDir = characterDataDir(data, character);
  const created = new Date(now).toISOString();
  const index = await ensureThreads(data, character, created);
  const sealed = sealedThreads(characterDir);
  if (threadRecord(index, request.id) !== undefined || sealed.some((each) => each.id === request.id)) {
    throw new ThreadError("exists", `thread ${JSON.stringify(request.id)} already exists for ${character}`);
  }
  await mkdir(threadDataDir(data, character, request.id), { recursive: true });
  startReadMarkBefore(data, character, request.id, now);
  const added: SealedThread = { id: request.id, label, unseal_at: new Date(request.unsealAt).toISOString(), created_at: created };
  keepSealedThreads(characterDir, [...sealed, added]);
  return added;
}

export interface OpenedSeals {
  opened: SealedThread[];
  index: ThreadsIndex | undefined;
}

export async function openDueSeals(data: string, character: string, now: number): Promise<OpenedSeals> {
  const characterDir = characterDataDir(data, character);
  const sealed = sealedThreads(characterDir);
  const opened = sealed.filter((each) => Date.parse(each.unseal_at) <= now);
  if (opened.length === 0) return { opened, index: undefined };
  for (const each of opened) {
    const listed = await readThreadsIndex(data, character);
    if (listed !== undefined && threadRecord(listed, each.id) !== undefined) continue;
    await createThread(data, character, each.id, each.created_at, { label: each.label, compaction: true, created_by: "character" });
  }
  keepSealedThreads(characterDir, sealed.filter((each) => !opened.includes(each)));
  return { opened, index: await readThreadsIndex(data, character) };
}
