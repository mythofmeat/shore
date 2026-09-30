import type { BrowserConnection } from "../connection.ts";
import type { WebRequestList } from "../../protocol/WebRequestList.ts";
import { browserDraft, forgetSending, unclaimedSending, withSendingLock, type SendingMessage } from "../drafts.ts";
import { sentFate } from "./sending.ts";

export class UnsentMessages {
  #waiting: ReadonlySet<string> = new Set();
  #busy = false;
  #again = false;
  constructor(connection: BrowserConnection, readonly list: () => Promise<WebRequestList>, readonly restored: (message: SendingMessage, dropped: number) => void) {
    connection.subscribe((update) => {
      if (update.kind === "status" && update.status === "ready") this.check();
      else if (update.kind === "frame" && update.message.type === "request_finished" && (this.#busy || this.#waiting.has(update.message.rid))) this.check();
    });
  }

  check(): void {
    if (this.#busy) { this.#again = true; return; }
    this.#busy = true;
    void (async () => {
      do {
        this.#again = false;
        await withSendingLock(() => this.#settle()).catch(() => {});
      } while (this.#again);
      this.#busy = false;
    })();
  }

  async #settle(): Promise<void> {
    const unclaimed = await unclaimedSending();
    if (unclaimed.length === 0) { this.#waiting = new Set(); return; }
    const { requests } = await this.list();
    const waiting = new Set<string>();
    for (const message of unclaimed) {
      const fate = sentFate(requests.find((request) => request.rid === message.rid));
      if (fate === "waiting") waiting.add(message.rid);
      else if (fate === "saved") await forgetSending(message.rid);
      else {
        const { restored, dropped } = await browserDraft(message.conversation).restore(message.rid);
        if (restored) this.restored(message, dropped);
      }
    }
    this.#waiting = waiting;
  }
}
