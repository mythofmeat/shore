import type { ServerMessage } from "../protocol/ServerMessage.ts";

export type SyncDecision = "deliver" | "drop_stale" | "resync";

export interface SyncSnapshot {
  character: string | null;
  thread: string | null;
  messageRevision: number;
  snapshotRevision: number;
}

export class SyncState {
  #state: SyncSnapshot;

  constructor(revision = 0, character: string | null = null, thread: string | null = null) {
    this.#state = { character, thread, messageRevision: revision, snapshotRevision: revision };
  }

  get snapshot(): Readonly<SyncSnapshot> { return { ...this.#state }; }
  get latestRevision(): number { return Math.max(this.#state.messageRevision, this.#state.snapshotRevision); }

  observe(message: ServerMessage): SyncDecision {
    const state = this.#state;
    switch (message.type) {
      case "history": {
        const character = message.selected_character ?? null;
        const thread = message.selected_thread ?? null;
        if (message.delta !== null && message.delta !== undefined) {
          if (character !== state.character || (thread ?? "main") !== (state.thread ?? "main") || message.revision <= state.snapshotRevision) return "drop_stale";
          if (message.delta.base_revision !== state.snapshotRevision) return "resync";
          state.snapshotRevision = message.revision;
          return "deliver";
        }
        if (character !== state.character || (thread !== null && thread !== state.thread)) {
          this.#state = { character, thread, messageRevision: message.revision, snapshotRevision: message.revision };
          return "deliver";
        }
        if (message.revision < state.snapshotRevision) return "drop_stale";
        state.snapshotRevision = message.revision;
        return "deliver";
      }
      case "new_message":
        if ((message.character ?? null) !== state.character || (message.thread ?? "main") !== (state.thread ?? "main") || message.revision <= state.messageRevision) return "drop_stale";
        state.messageRevision = message.revision;
        return "deliver";
      case "hello":
      case "shutdown":
      case "ping":
      case "command_output":
      case "error":
      case "stream_start":
      case "stream_chunk":
      case "stream_end":
      case "phase":
      case "tool_call":
      case "tool_result":
      case "send_image":
      case "cache_warning":
      case "provider_warning":
      case "provider_fallback_warning":
      case "usage_warning":
      case "config_warning":
      case "request_accepted":
      case "request_finished":
        return "deliver";
    }
  }
}
