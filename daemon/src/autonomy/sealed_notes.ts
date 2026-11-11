import { formatWallClock } from "../engine/prompt.ts";
import type { SealedThread } from "../engine/sealed_list.ts";

export function sealedListNote(sealed: readonly SealedThread[], timeZone: string): string | undefined {
  if (sealed.length === 0) return undefined;
  const lines = sealed.map((thread) => `- \`${thread.id}\` "${thread.label}", opens ${formatWallClock(Date.parse(thread.unseal_at), timeZone)}`);
  return `[Your sealed threads. Only a wake inside one can see what is in it, and \`wake_in_thread\` takes you there.\n${lines.join("\n")}]`;
}

export function sealedWakeNote(sealed: SealedThread, filesDir: string, userName: string, timeZone: string): string {
  return `[This thread is sealed until ${formatWallClock(Date.parse(sealed.unseal_at), timeZone)}. ${userName} can't see it, or anything you do or send here, until then, ` +
    `and your other threads are shown only its label, "${sealed.label}". What you send here waits in the thread for them. ` +
    `Keep what you make for it in ${filesDir}, which is outside your workspace.]`;
}
