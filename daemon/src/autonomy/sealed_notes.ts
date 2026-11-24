import { formatWallClock } from "../engine/prompt.ts";
import type { SealedThread } from "../engine/sealed_list.ts";
import type { Texts } from "../texts/texts.ts";

export function sealedListNote(texts: Texts, sealed: readonly SealedThread[], timeZone: string): string | undefined {
  if (sealed.length === 0) return undefined;
  const lines = sealed.flatMap((thread) => texts.render("sealed_list_thread", { thread: thread.id, label: thread.label, opens: formatWallClock(Date.parse(thread.unseal_at), timeZone) }) ?? []);
  return texts.render("sealed_list", { threads: lines.join("\n") });
}

export function sealedWakeNote(texts: Texts, sealed: SealedThread, filesDir: string, userName: string, timeZone: string): string | undefined {
  return texts.render("sealed_wake", { opens: formatWallClock(Date.parse(sealed.unseal_at), timeZone), user: userName, label: sealed.label, folder: filesDir });
}
