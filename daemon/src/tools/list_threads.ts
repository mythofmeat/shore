import { sealedListNote } from "../autonomy/sealed_notes.ts";
import { characterDataDir } from "../config/dirs.ts";
import { sealedThreads } from "../engine/sealed_list.ts";
import { folderOf } from "../engine/thread_layout.ts";
import { defaultThreadsIndex, homeThread, readThreadsIndex, threadActivities, threadAway, wakesThread, type ThreadActivity, type ThreadRecord } from "../engine/threads.ts";
import { formatWallClock, lengthPhrase } from "../engine/prompt.ts";
import { hostZone } from "../ledger/zoned.ts";
import type { Texts } from "../texts/texts.ts";

export interface ListThreadsOptions {
  texts: Texts;
  dataDir: string;
  character: string;
  thread?: string;
  userName: string;
  timeZone?: string;
  now?: () => number;
}

function when(texts: Texts, at: string | undefined, zone: string): string | undefined {
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(ms) ? undefined : formatWallClock(texts, ms, zone);
}

function described(
  record: ThreadRecord,
  activity: ThreadActivity | undefined,
  marks: (string | undefined)[],
  options: ListThreadsOptions,
  zone: string,
  nowMs: number,
): string | undefined {
  const lastMs = Date.parse(activity?.last_user ?? "");
  const shown = marks.filter((mark) => mark !== undefined);
  return options.texts.render("threads_entry", {
    thread: record.id,
    label: record.label,
    marks: shown.length === 0 ? undefined : shown.join(", "),
    compaction: record.compaction ? "yes" : undefined,
    purpose: record.purpose,
    pins: record.pins === undefined || record.pins.length === 0 ? undefined : record.pins.join(", "),
    by_you: record.created_by === "character" ? "yes" : undefined,
    user: options.userName,
    started: when(options.texts, record.created_at, zone) ?? record.created_at,
    last: Number.isNaN(lastMs) ? undefined : formatWallClock(options.texts, lastMs, zone),
    length: Number.isNaN(lastMs) ? undefined : lengthPhrase(options.texts, (nowMs - lastMs) / 1000),
  });
}

export async function handleListThreads(options: ListThreadsOptions): Promise<string> {
  const nowMs = (options.now ?? Date.now)();
  const zone = options.timeZone ?? hostZone();
  const index = await readThreadsIndex(options.dataDir, options.character) ?? defaultThreadsIndex(new Date(nowMs).toISOString());
  const home = homeThread(index);
  const wakes = wakesThread(index);
  const sealed = sealedThreads(characterDataDir(options.dataDir, options.character));
  const sealedHere = sealed.find((thread) => thread.id === options.thread)?.id;
  const current = sealedHere ?? (index.threads.some((thread) => thread.id === options.thread) ? options.thread ?? home : home);
  const seen = index.threads.filter((thread) => threadAway(thread) === undefined || thread.id === current);
  const activity = await threadActivities(options.dataDir, options.character, seen.map((thread) => thread.id));
  const threads = [...seen].sort((a, b) => Number(b.id === home) - Number(a.id === home));
  const texts = options.texts;
  const shown = threads.map((record) => {
    const folder = folderOf(index, record.id);
    return described(record, activity.get(record.id), [
      record.id === home ? texts.render("threads_mark_home") : undefined,
      record.id === current ? texts.render("threads_mark_here") : undefined,
      record.id === wakes ? texts.render("threads_mark_wakes") : undefined,
      record.locked === true ? texts.render("threads_mark_locked") : undefined,
      folder === undefined ? undefined : texts.render("threads_mark_folder", { folder }),
    ], options, zone, nowMs);
  });
  const heading = texts.render("threads_home", { home, here: current === home ? "yes" : undefined, thread: current, sealed: sealedHere === undefined ? undefined : "yes" });
  return [heading, ...shown, sealedListNote(texts, sealed, zone)].filter((part) => part !== undefined).join("\n\n");
}
