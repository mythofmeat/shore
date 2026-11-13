import { sealedListNote } from "../autonomy/sealed_notes.ts";
import { characterDataDir } from "../config/dirs.ts";
import { sealedThreads } from "../engine/sealed_list.ts";
import { folderOf } from "../engine/thread_layout.ts";
import { defaultThreadsIndex, homeThread, readThreadsIndex, threadActivities, type ThreadActivity, type ThreadRecord } from "../engine/threads.ts";
import { agoPhrase, formatWallClock } from "../engine/prompt.ts";
import { hostZone } from "../ledger/zoned.ts";

export interface ListThreadsOptions {
  dataDir: string;
  character: string;
  thread?: string;
  userName: string;
  timeZone?: string;
  now?: () => number;
}

function when(at: string | undefined, zone: string): string | undefined {
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(ms) ? undefined : formatWallClock(ms, zone);
}

function described(
  record: ThreadRecord,
  activity: ThreadActivity | undefined,
  marks: string[],
  options: ListThreadsOptions,
  zone: string,
  nowMs: number,
): string {
  const user = options.userName;
  const name = record.label === undefined ? record.id : `${record.id} "${record.label}"`;
  const started = when(record.created_at, zone) ?? record.created_at;
  const lastMs = Date.parse(activity?.last_user ?? "");
  const lines = [
    `${name}${marks.length === 0 ? "" : ` (${marks.join(", ")})`} · compaction ${record.compaction ? "on" : "off"}`,
    ...(record.purpose === undefined ? [] : [`  purpose: ${record.purpose}`]),
    ...(record.files === undefined || record.files.length === 0 ? [] : [`  files: ${record.files.join(", ")}`]),
    `  started by ${record.created_by === "character" ? "you" : user} on ${started}`,
    Number.isNaN(lastMs)
      ? `  ${user} hasn't written here yet`
      : `  ${user} last wrote here ${formatWallClock(lastMs, zone)}, ${agoPhrase((nowMs - lastMs) / 1000)}`,
  ];
  return lines.join("\n");
}

export async function handleListThreads(options: ListThreadsOptions): Promise<string> {
  const nowMs = (options.now ?? Date.now)();
  const zone = options.timeZone ?? hostZone();
  const index = await readThreadsIndex(options.dataDir, options.character) ?? defaultThreadsIndex(new Date(nowMs).toISOString());
  const home = homeThread(index);
  const sealed = sealedThreads(characterDataDir(options.dataDir, options.character));
  const sealedHere = sealed.find((thread) => thread.id === options.thread)?.id;
  const current = sealedHere ?? (index.threads.some((thread) => thread.id === options.thread) ? options.thread ?? home : home);
  const activity = await threadActivities(options.dataDir, options.character, index.threads.map((thread) => thread.id));
  const threads = [...index.threads].sort((a, b) => Number(b.id === home) - Number(a.id === home));
  const shown = threads.map((record) => described(record, activity.get(record.id), [
    ...(record.id === home ? ["home"] : []),
    ...(record.id === current ? ["you're here"] : []),
    ...(record.locked === true ? ["locked"] : []),
    ...[folderOf(index, record.id)].flatMap((folder) => folder === undefined ? [] : [`in the folder "${folder}"`]),
  ], options, zone, nowMs));
  const where = current === home ? `You're in it.` : `You're in "${current}"${sealedHere === undefined ? "" : ", which is sealed"}.`;
  const kept = sealedListNote(sealed, zone);
  return [`Your home thread is "${home}". ${where}`, ...shown, ...(kept === undefined ? [] : [kept])].join("\n\n");
}
