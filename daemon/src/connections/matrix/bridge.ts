import type { ServerMessage } from "../../protocol/ServerMessage";

import { parseInput } from "./commands.ts";
import { EventMap } from "./event_map.ts";
import type { MatrixEvent } from "./events.ts";
import { sanitizeFilename } from "./events.ts";
import { formatUserMirror, parseReaction, routeMirror, type PendingImage, type RoomTarget } from "./mirror.ts";
import { ViewPrefs } from "./prefs.ts";
import { renderCommandOutput } from "./render.ts";
import { RoomBindings } from "./rooms.ts";
import type { LocalPeer } from "../../swp/server.ts";

export interface BridgeLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface BridgeBot {
  events(): AsyncGenerator<MatrixEvent>;
  sendText(roomId: string, markdown: string): Promise<string | undefined>;
  sendNotice(roomId: string, markdown: string): Promise<string | undefined>;
  editText(roomId: string, eventId: string, markdown: string): Promise<boolean>;
  redact(roomId: string, eventId: string, reason?: string): Promise<void>;
  setTyping(roomId: string, typing: boolean): Promise<void>;
  sendImage(roomId: string, path: string, caption?: string): Promise<string | undefined>;
  downloadMedia(url: string): Promise<Uint8Array | undefined>;
}

export interface BridgeOptions {
  readonly bot: BridgeBot;
  readonly peer: LocalPeer;
  readonly rooms: RoomBindings;
  readonly events: EventMap;
  readonly prefs: ViewPrefs;
  readonly mirrorAll: boolean;
  readonly initialRoomId?: string | undefined;
  readonly log?: BridgeLogger;
}

interface PendingEcho {
  readonly roomId: string;
  readonly text: string;
  readonly eventId: string;
}

interface PendingCommand {
  readonly roomId: string | undefined;
  readonly silent: boolean;
  readonly settle: (data: unknown) => void;
}

const MAX_PENDING_ECHOES = 32;

const COMMAND_TIMEOUT_MS = 15_000;

export class Bridge {
  readonly #options: BridgeOptions;
  readonly #echoes: PendingEcho[] = [];
  readonly #commands = new Map<string, PendingCommand>();
  #characters: readonly string[] = [];
  #selected: string | undefined;
  #activeRoom: string | undefined;
  #nextRid = 1;

  constructor(options: BridgeOptions) {
    this.#options = options;
    this.#characters = options.peer.characters.map((c) => c.name);
    this.#selected = options.peer.history.selectedCharacter ?? undefined;
  }

  async run(): Promise<void> {
    await this.#adoptInitialRoom();
    await Promise.all([this.#pumpMatrix(), this.#pumpDaemon()]);
  }

  async #pumpMatrix(): Promise<void> {
    for await (const event of this.#options.bot.events()) {
      try {
        await this.#onMatrixEvent(event);
      } catch (e) {
        this.#options.log?.warn?.("Matrix event handler failed", {
          kind: event.kind,
          error: String(e),
        });
      }
    }
  }

  async #pumpDaemon(): Promise<void> {
    for await (const msg of this.#options.peer.events()) {
      try {
        await this.#onDaemonFrame(msg);
      } catch (e) {
        this.#options.log?.warn?.("daemon frame handler failed", {
          type: msg.type,
          error: String(e),
        });
      }
    }
    this.#failPendingCommands();
  }

  async #onMatrixEvent(event: MatrixEvent): Promise<void> {
    switch (event.kind) {
      case "message":
        return await this.#onText(event.roomId, event.eventId, event.text);
      case "image":
        return await this.#onImage(event);
      case "edit":
        return await this.#onEdit(event.roomId, event.targetEventId, event.newText);
      case "redaction":
        return await this.#onRedaction(event.roomId, event.redacts);
      case "reaction":
        return await this.#onReaction(event.roomId, event.targetEventId, event.key);
    }
  }

  async #onText(roomId: string, eventId: string, text: string): Promise<void> {
    const input = parseInput(text);

    switch (input.kind) {
      case "reply":
        await this.#options.bot.sendNotice(roomId, input.text);
        return;

      case "bind":
        return await this.#bind(roomId, input.character);

      case "unbind":
        this.#options.rooms.unbindRoom(roomId);
        await this.#options.bot.sendNotice(roomId, "This room is no longer bound to a character.");
        return;

      case "view":
        return await this.#view(roomId, input.key, input.value);

      case "cancel":
        if (!(await this.#target(roomId))) return;
        await this.#options.peer.send({ type: "cancel" });
        return;

      case "regen":
        if (!(await this.#target(roomId))) return;
        this.#activeRoom = roomId;
        await this.#options.peer.send({ type: "regen", stream: true });
        return;

      case "command":
        if (!(await this.#target(roomId))) return;
        await this.#runCommand(input.name, input.args, roomId, false);
        return;

      case "text": {
        if (!(await this.#target(roomId))) return;
        this.#activeRoom = roomId;
        this.#rememberEcho({ roomId, text: input.text, eventId });
        await this.#options.peer.send({
          type: "message",
          text: input.text,
          stream: true,
          images: [],
          image_data: [],
        });
      }
    }
  }

  async #onImage(event: Extract<MatrixEvent, { kind: "image" }>): Promise<void> {
    if (!(await this.#target(event.roomId))) return;

    const bytes = await this.#options.bot.downloadMedia(event.url);
    if (bytes === undefined) {
      await this.#options.bot.sendNotice(event.roomId, "That image could not be downloaded.");
      return;
    }

    const filename = sanitizeFilename(event.body);
    const caption = event.body === filename ? "" : event.body;
    this.#activeRoom = event.roomId;
    this.#rememberEcho({ roomId: event.roomId, text: caption, eventId: event.eventId });

    await this.#options.peer.send({
      type: "message",
      text: caption,
      stream: true,
      images: [],
      image_data: [
        {
          filename,
          data: Buffer.from(bytes).toString("base64"),
          ...(event.mimeType === undefined ? {} : { mime_type: event.mimeType }),
        },
      ],
    });
  }

  async #onEdit(roomId: string, targetEventId: string, newText: string): Promise<void> {
    const mapped = this.#options.events.byEventId(targetEventId);
    if (mapped === undefined) {
      await this.#options.bot.sendNotice(roomId, "That message is no longer tracked, so the edit was not applied.");
      return;
    }
    if (!(await this.#target(roomId))) return;
    await this.#runCommand("edit", { ref: mapped.msgId, content: newText }, roomId, true);
    this.#options.events.updateContent(mapped.msgId, newText);
  }

  async #onRedaction(roomId: string, redacts: string): Promise<void> {
    const mapped = this.#options.events.byEventId(redacts);
    if (mapped === undefined) return;
    if (!(await this.#target(roomId))) return;
    await this.#runCommand("delete", { refs: [mapped.msgId] }, roomId, true);
    this.#options.events.removeEvent(redacts);
  }

  async #onReaction(roomId: string, targetEventId: string, key: string): Promise<void> {
    const control = parseReaction(key);
    if (control === undefined) return;
    const mapped = this.#options.events.byEventId(targetEventId);
    if (mapped === undefined) return;
    if (!(await this.#target(roomId))) return;

    switch (control) {
      case "regen": {
        const latest = this.#options.events.latestReplyInRoom(roomId);
        if (latest?.eventId !== targetEventId) {
          await this.#options.bot.sendNotice(roomId, "Only the most recent reply can be regenerated.");
          return;
        }
        this.#activeRoom = roomId;
        await this.#options.peer.send({ type: "regen", stream: true });
        return;
      }
      case "delete":
        await this.#runCommand("delete", { refs: [mapped.msgId] }, roomId, true);
        this.#options.events.removeEvent(targetEventId);
        await this.#options.bot.redact(roomId, targetEventId, "deleted from shore");
        return;
      case "alt_prev":
      case "alt_next":
        await this.#runCommand(
          "alt",
          { ref: mapped.msgId, direction: control === "alt_prev" ? "prev" : "next" },
          roomId,
          false,
        );
    }
  }

  async #adoptInitialRoom(): Promise<void> {
    const roomId = this.#options.initialRoomId;
    if (roomId === undefined || roomId === "" || this.#options.rooms.isBound(roomId)) return;

    const only = this.#characters.length === 1 ? this.#characters[0] : undefined;
    if (only === undefined) {
      await this.#options.bot.sendNotice(
        roomId,
        "This room is not bound to a character yet. Use `!bind <character>` — `!bind` on its own lists them.",
      );
      return;
    }
    if (!(await this.#persistBinding(roomId, only))) return;
    await this.#options.bot.sendNotice(roomId, `This room is now bound to **${only}**.`);
  }

  async #bind(roomId: string, character: string | undefined): Promise<void> {
    if (character === undefined) {
      const bound = this.#options.rooms.characterForRoom(roomId);
      const list = this.#characters.map((name) => `- \`${name}\``).join("\n");
      await this.#options.bot.sendNotice(
        roomId,
        [
          bound === undefined ? "This room is not bound." : `This room is bound to **${bound}**.`,
          this.#characters.length === 0 ? "_No characters available._" : `Available:\n${list}`,
          "Bind with `!bind <character>`.",
        ].join("\n\n"),
      );
      return;
    }

    if (!this.#characters.includes(character)) {
      await this.#options.bot.sendNotice(roomId, `No such character: \`${character}\`.`);
      return;
    }
    if (!(await this.#persistBinding(roomId, character))) return;
    await this.#options.bot.sendNotice(roomId, `This room is now bound to **${character}**.`);
  }

  async #persistBinding(roomId: string, character: string): Promise<boolean> {
    try {
      this.#options.rooms.bind(roomId, character);
      return true;
    } catch (e) {
      this.#options.log?.warn?.("failed to persist room binding", {
        room_id: roomId,
        character,
        error: String(e),
      });
      await this.#options.bot.sendNotice(
        roomId,
        `Could not save that binding, so it would not survive a restart: ${String(e)}`,
      );
      return false;
    }
  }

  async #view(roomId: string, key: string | undefined, value: boolean | undefined): Promise<void> {
    if (key === undefined) {
      const view = this.#options.prefs.room(roomId);
      const lines = Object.entries(view).map(([k, v]) => `- ${k}: ${v ? "on" : "off"}`);
      await this.#options.bot.sendNotice(roomId, `**This room shows**\n${lines.join("\n")}`);
      return;
    }
    const now = this.#options.prefs.set(roomId, key, value);
    await this.#options.bot.sendNotice(
      roomId,
      now === undefined ? `Unknown view key: \`${key}\`.` : `\`${key}\` is now ${now ? "on" : "off"}.`,
    );
  }

  async #target(roomId: string): Promise<boolean> {
    const character = this.#options.rooms.characterForRoom(roomId);
    if (character === undefined) {
      await this.#options.bot.sendNotice(roomId, "This room is not bound. Use `!bind <character>`.");
      return false;
    }
    if (character === this.#selected) return true;

    const switched = await this.#awaitCommand("switch_character", { name: character }, undefined, true);
    const selected = isRecord(switched) ? switched.selected_character : undefined;
    if (typeof selected !== "string") {
      await this.#options.bot.sendNotice(roomId, `Could not switch to **${character}**.`);
      return false;
    }
    this.#selected = selected;
    return true;
  }

  async #runCommand(
    name: string,
    args: Record<string, unknown>,
    roomId: string | undefined,
    silent: boolean,
  ): Promise<void> {
    const rid = `matrix-${this.#nextRid}`;
    this.#nextRid += 1;
    this.#commands.set(rid, { roomId, silent, settle: () => {} });
    this.#expire(rid);
    await this.#options.peer.send({ type: "command", rid, name, args });
  }

  async #awaitCommand(
    name: string,
    args: Record<string, unknown>,
    roomId: string | undefined,
    silent: boolean,
  ): Promise<unknown> {
    const rid = `matrix-${this.#nextRid}`;
    this.#nextRid += 1;

    const settled = new Promise<unknown>((resolve) => {
      this.#commands.set(rid, { roomId, silent, settle: resolve });
    });
    this.#expire(rid);
    await this.#options.peer.send({ type: "command", rid, name, args });
    return await settled;
  }

  #expire(rid: string): void {
    const timer = setTimeout(() => {
      const pending = this.#commands.get(rid);
      if (pending === undefined) return;
      this.#commands.delete(rid);
      this.#options.log?.warn?.("no answer from the daemon", { rid });
      pending.settle(undefined);
    }, COMMAND_TIMEOUT_MS);
    timer.unref?.();
  }

  #failPendingCommands(): void {
    for (const pending of this.#commands.values()) pending.settle(undefined);
    this.#commands.clear();
  }

  async #onDaemonFrame(msg: ServerMessage): Promise<void> {
    const rid = "rid" in msg ? (msg.rid ?? undefined) : undefined;
    const pending = rid === undefined ? undefined : this.#commands.get(rid);
    if (pending !== undefined && (msg.type === "command_output" || msg.type === "error")) {
      this.#commands.delete(rid as string);
      pending.settle(msg.type === "command_output" ? msg.data : undefined);
      if (pending.silent) {
        if (msg.type === "error") {
          const room = pending.roomId ?? this.#activeRoom;
          if (room !== undefined) await this.#options.bot.sendNotice(room, `⚠️ ${msg.message}`);
        }
        return;
      }
    }

    const route = routeMirror(msg);
    const roomId = this.#resolveRoom(route.target, pending?.roomId);
    if (roomId === undefined) return;

    switch (route.action.kind) {
      case "start_typing":
        return await this.#options.bot.setTyping(roomId, true);
      case "stop_typing":
        return await this.#options.bot.setTyping(roomId, false);
      case "post":
        return await this.#post(roomId, route.action);
      case "user_prompt":
        return await this.#mirrorPrompt(roomId, route.action.msgId, route.action.content);
      case "command_output":
        return void (await this.#options.bot.sendNotice(
          roomId,
          renderCommandOutput(route.action.name, route.action.data),
        ));
      case "error":
      case "notice":
        return void (await this.#options.bot.sendNotice(roomId, route.action.text));
      case "none":
    }
  }

  #resolveRoom(target: RoomTarget, requester: string | undefined): string | undefined {
    if (target.kind === "active") return requester ?? this.#activeRoom;
    if (target.character === undefined) return this.#activeRoom;
    return this.#options.rooms.roomForCharacter(target.character) ?? this.#activeRoom;
  }

  async #post(
    roomId: string,
    action: Extract<ReturnType<typeof routeMirror>["action"], { kind: "post" }>,
  ): Promise<void> {
    const body = this.#withThinking(roomId, action.text, action.thinking);

    if (action.replacesLast) {
      const previous =
        (action.msgId === undefined ? undefined : this.#options.events.byMsgId(action.msgId)) ??
        this.#options.events.latestReplyInRoom(roomId);
      if (previous !== undefined && (await this.#options.bot.editText(roomId, previous.eventId, body))) {
        if (action.msgId !== undefined) {
          this.#options.events.record({
            msgId: action.msgId,
            roomId,
            eventId: previous.eventId,
            origin: "assistant",
            content: action.text,
          });
        }
        await this.#sendImages(roomId, action.images);
        return;
      }
    }

    const eventId = await this.#options.bot.sendText(roomId, body);
    if (eventId !== undefined && action.msgId !== undefined) {
      this.#options.events.record({
        msgId: action.msgId,
        roomId,
        eventId,
        origin: "assistant",
        content: action.text,
      });
    }
    await this.#sendImages(roomId, action.images);
  }

  #withThinking(roomId: string, text: string, thinking: string | undefined): string {
    if (thinking === undefined || !this.#options.prefs.room(roomId).thinking) return text;
    const quoted = thinking
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `${quoted}\n\n${text}`;
  }

  async #sendImages(roomId: string, images: readonly PendingImage[]): Promise<void> {
    for (const image of images) {
      await this.#options.bot.sendImage(roomId, image.path, image.caption);
    }
  }

  async #mirrorPrompt(
    roomId: string,
    msgId: string | undefined,
    content: string,
  ): Promise<void> {
    const echo = this.#takeEcho(roomId, content);
    if (echo !== undefined) {
      if (msgId !== undefined) {
        this.#options.events.record({
          msgId,
          roomId,
          eventId: echo.eventId,
          origin: "matrix_user",
          content,
        });
      }
      return;
    }

    if (!this.#options.mirrorAll) return;

    const eventId = await this.#options.bot.sendNotice(roomId, formatUserMirror(content));
    if (eventId !== undefined && msgId !== undefined) {
      this.#options.events.record({
        msgId,
        roomId,
        eventId,
        origin: "mirrored_user",
        content,
      });
    }
  }

  #rememberEcho(echo: PendingEcho): void {
    this.#echoes.push(echo);
    if (this.#echoes.length > MAX_PENDING_ECHOES) this.#echoes.shift();
  }

  #takeEcho(roomId: string, content: string): PendingEcho | undefined {
    const at = this.#echoes.findIndex((e) => e.roomId === roomId && e.text === content);
    if (at === -1) return undefined;
    const [echo] = this.#echoes.splice(at, 1);
    return echo;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
