import type { DiaryNote, Message } from "../engine/types.ts";
import { shoreLog } from "../log.ts";
import { sealedThreads } from "../engine/sealed_list.ts";
import { readCharacterState, writeCharacterState } from "../storage/store.ts";

const DIARY_STATE = "diary.json";

export const DIARY_NOTE_CHARS = 1500;

export const DIARY_KEPT = 100;

export const DIARY_SHOWN = 20;

export const DIARY_WINDOW_MS = 86_400_000;

const SENT = /<sendMessage>[\s\S]*?<\/sendMessage>/g;

const NOTHING_TO_NOTE = "HEARTBEAT_OK";

const SOURCES = ["heartbeat", "wake", "trigger", "shore", "note"] as const;

interface StoredNote extends DiaryNote {
  folded?: true;
}

function storedNote(raw: unknown): StoredNote | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { id, at, thread, source, trigger, text, folded } = raw as Record<string, unknown>;
  if (typeof id !== "string" || typeof thread !== "string" || typeof text !== "string") return undefined;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return undefined;
  const known = SOURCES.find((each) => each === source);
  if (known === undefined) return undefined;
  return { id, at, thread, source: known, ...(typeof trigger === "string" ? { trigger } : {}), text, ...(folded === true ? { folded } : {}) };
}

function stored(characterDir: string): StoredNote[] {
  try {
    const parsed: unknown = JSON.parse(readCharacterState(characterDir, DIARY_STATE) ?? "[]");
    if (Array.isArray(parsed)) return parsed.flatMap((raw) => storedNote(raw) ?? []);
  } catch (error) {
    shoreLog.error(`shore: could not read the diary at ${characterDir}: ${String(error)}`);
  }
  return [];
}

function keep(characterDir: string, notes: readonly StoredNote[]): void {
  writeCharacterState(characterDir, DIARY_STATE, JSON.stringify(notes.slice(-DIARY_KEPT)));
}

function shown({ folded: _folded, ...note }: StoredNote): DiaryNote {
  return note;
}

function open(characterDir: string): StoredNote[] {
  const sealed = new Set(sealedThreads(characterDir).map((thread) => thread.id));
  return stored(characterDir).filter((note) => !sealed.has(note.thread));
}

export function closingNote(text: string): string | undefined {
  const note = text.replace(SENT, "").trim();
  return note === "" || note === NOTHING_TO_NOTE ? undefined : note;
}

export interface NewDiaryNote {
  at: number;
  thread: string;
  source: DiaryNote["source"];
  trigger?: string;
  text: string;
}

export function addDiaryNote(characterDir: string, note: NewDiaryNote, newId: () => string = () => `d_${crypto.randomUUID()}`): void {
  const chars = Array.from(note.text);
  const text = chars.length > DIARY_NOTE_CHARS ? `${chars.slice(0, DIARY_NOTE_CHARS).join("")}… [cut]` : note.text;
  const added: StoredNote = {
    id: newId(), at: new Date(note.at).toISOString(), thread: note.thread, source: note.source,
    ...(note.trigger === undefined ? {} : { trigger: note.trigger }), text,
  };
  const earlier = stored(characterDir).filter((each) => note.trigger === undefined || each.trigger !== note.trigger);
  keep(characterDir, [...earlier, added]);
}

export interface ShownDiary {
  notes: DiaryNote[];
  omitted: number;
}

function lastDay(notes: readonly StoredNote[], now: number): StoredNote[] {
  return notes.filter((note) => now - Date.parse(note.at) < DIARY_WINDOW_MS);
}

export function recentDiary(characterDir: string, now: number): ShownDiary {
  const recent = lastDay(open(characterDir), now).map(shown);
  const notes = recent.slice(-DIARY_SHOWN);
  return { notes, omitted: recent.length - notes.length };
}

export interface KeptNote extends DiaryNote {
  shown: boolean;
  dreamed: boolean;
}

export function keptDiary(characterDir: string, now: number): KeptNote[] {
  const kept = open(characterDir);
  const current = new Set(lastDay(kept, now).slice(-DIARY_SHOWN));
  return kept.map((note) => ({ ...shown(note), shown: current.has(note), dreamed: note.folded === true }));
}

export function unseenDiary(characterDir: string, active: readonly Pick<Message, "diary">[], now: number, thread?: string): DiaryNote[] {
  const seen = new Set(active.flatMap((message) => (message.diary ?? []).map((note) => note.id)));
  return recentDiary(characterDir, now).notes.filter((note) => !seen.has(note.id) && note.thread !== thread);
}

export function unfoldedDiary(characterDir: string): DiaryNote[] {
  return open(characterDir).filter((note) => note.folded !== true).map(shown);
}

export function foldDiary(characterDir: string, ids: readonly string[]): void {
  const folded = new Set(ids);
  keep(characterDir, stored(characterDir).map((note): StoredNote => folded.has(note.id) ? { ...note, folded: true } : note));
}
