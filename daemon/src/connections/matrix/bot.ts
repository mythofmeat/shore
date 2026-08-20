import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  ClientEvent,
  createClient,
  Direction,
  EventType,
  MatrixEvent as SdkEvent,
  MemoryStore,
  RoomEvent,
  RoomMemberEvent,
  SyncState,
  type MatrixClient,
  type Room,
  type RoomMember,
  type SyncStateData,
} from "matrix-js-sdk";

import { normalizeEvent, type MatrixEvent, type RawEvent } from "./events.ts";

const TYPING_TIMEOUT_MS = 20_000;

export const SYNC_START_TIMEOUT_MS = 60_000;

const TERMINAL_ERRCODES = new Set(["M_UNKNOWN_TOKEN", "M_MISSING_TOKEN", "M_FORBIDDEN"]);

export interface BotConfig {
  readonly homeserver: string;
  readonly userId: string;
  readonly accessToken?: string | undefined;
  readonly password?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly log?: BotLogger;
}

export interface BotLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export class MatrixBot {
  readonly #client: MatrixClient;
  readonly #userId: string;
  readonly #log: BotLogger | undefined;
  readonly #pending: MatrixEvent[] = [];
  readonly #faulted: Promise<Error>;
  #reportFault!: (fault: Error) => void;
  #wake: (() => void) | null = null;
  #stopped = false;

  private constructor(client: MatrixClient, userId: string, log: BotLogger | undefined) {
    this.#client = client;
    this.#userId = userId;
    this.#log = log;
    this.#faulted = new Promise<Error>((resolve) => {
      this.#reportFault = resolve;
    });
  }

  static async login(config: BotConfig): Promise<MatrixBot> {
    const client = createClient({
      baseUrl: config.homeserver,
      store: new MemoryStore(),
      ...(config.accessToken === undefined ? {} : { accessToken: config.accessToken }),
      userId: config.userId,
      ...(config.deviceId === undefined ? {} : { deviceId: config.deviceId }),
    });

    if (config.accessToken === undefined) {
      if (config.password === undefined) {
        throw new Error("the Matrix bridge needs either an access token or a password");
      }
      const session = await client.login("m.login.password", {
        user: config.userId,
        password: config.password,
        initial_device_display_name: "Shore Matrix Bridge",
        ...(config.deviceId === undefined ? {} : { device_id: config.deviceId }),
      });
      config.log?.info?.("logged in with a password", { device_id: session.device_id });
    }

    const bot = new MatrixBot(client, config.userId, config.log);
    bot.#listen();
    return bot;
  }

  get userId(): string {
    return this.#userId;
  }

  get faulted(): Promise<Error> {
    return this.#faulted;
  }

  async start(): Promise<void> {
    await this.#client.startClient({ initialSyncLimit: 0 });
    try {
      await awaitInitialSync(this.#client);
    } catch (e) {
      this.#client.stopClient();
      throw e;
    }
    this.#watchSync();
    this.#log?.info?.("Matrix sync started");
  }

  #watchSync(): void {
    watchForSyncDeath(this.#client, (fault) => {
      if (this.#stopped) return;
      this.#log?.warn?.("Matrix sync ended", { error: String(fault) });
      this.#reportFault(fault);
      this.stop();
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#client.stopClient();
    this.#wake?.();
  }

  async *events(): AsyncGenerator<MatrixEvent> {
    for (;;) {
      const next = this.#pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#stopped) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = null;
    }
  }

  async sendText(roomId: string, markdown: string): Promise<string | undefined> {
    return await this.#send(roomId, textContent(markdown));
  }

  async sendNotice(roomId: string, markdown: string): Promise<string | undefined> {
    return await this.#send(roomId, { ...textContent(markdown), msgtype: "m.notice" });
  }

  async editText(roomId: string, eventId: string, markdown: string): Promise<boolean> {
    const fresh = textContent(markdown);
    const sent = await this.#send(roomId, {
      ...fresh,
      body: `* ${fresh.body}`,
      "m.new_content": fresh,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    });
    return sent !== undefined;
  }

  async redact(roomId: string, eventId: string, reason?: string): Promise<void> {
    try {
      await this.#client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);
    } catch (e) {
      this.#log?.warn?.("failed to redact", { room_id: roomId, event_id: eventId, error: String(e) });
    }
  }

  async setTyping(roomId: string, typing: boolean): Promise<void> {
    try {
      await this.#client.sendTyping(roomId, typing, typing ? TYPING_TIMEOUT_MS : 0);
    } catch (e) {
      this.#log?.warn?.("failed to set typing", { room_id: roomId, error: String(e) });
    }
  }

  async sendImage(roomId: string, path: string, caption?: string): Promise<string | undefined> {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (e) {
      this.#log?.warn?.("failed to read image", { path, error: String(e) });
      return undefined;
    }

    const name = basename(path);
    const mimeType = MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
    try {
      const upload = await this.#client.uploadContent(new Uint8Array(bytes), {
        name,
        type: mimeType,
      });
      return await this.#send(roomId, {
        msgtype: "m.image",
        body: caption ?? name,
        url: upload.content_uri,
        info: { mimetype: mimeType, size: bytes.length },
      });
    } catch (e) {
      this.#log?.warn?.("failed to send image", { room_id: roomId, error: String(e) });
      return undefined;
    }
  }

  async downloadMedia(mxcUrl: string): Promise<Uint8Array | undefined> {
    const http = this.#client.mxcUrlToHttp(
      mxcUrl,
      undefined,
      undefined,
      undefined,
      false,
      true,
      true,
    );
    if (http === null) return undefined;
    try {
      const response = await fetch(http, {
        headers: { Authorization: `Bearer ${this.#client.getAccessToken() ?? ""}` },
      });
      if (!response.ok) {
        this.#log?.warn?.("media download refused", { status: response.status });
        return undefined;
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (e) {
      this.#log?.warn?.("media download failed", { error: String(e) });
      return undefined;
    }
  }

  async setProfile(character: string, avatar?: { bytes: Uint8Array; mimeType: string }): Promise<void> {
    try {
      await this.#client.setDisplayName(character);
    } catch (e) {
      this.#log?.warn?.("failed to set display name", { error: String(e) });
    }
    if (avatar === undefined) return;
    try {
      const upload = await this.#client.uploadContent(avatar.bytes, { type: avatar.mimeType });
      await this.#client.setAvatarUrl(upload.content_uri);
    } catch (e) {
      this.#log?.warn?.("failed to set avatar", { error: String(e) });
    }
  }

  async resolveRoom(alias: string): Promise<string | undefined> {
    if (alias.startsWith("!")) return alias;
    try {
      return (await this.#client.getRoomIdForAlias(alias)).room_id;
    } catch (e) {
      this.#log?.warn?.("failed to resolve room alias", { alias, error: String(e) });
      return undefined;
    }
  }

  async #send(roomId: string, content: Record<string, unknown>): Promise<string | undefined> {
    try {
      const sent = await this.#client.sendEvent(roomId, EventType.RoomMessage, content as never);
      return sent.event_id;
    } catch (e) {
      this.#log?.warn?.("failed to send", { room_id: roomId, error: String(e) });
      return undefined;
    }
  }

  #listen(): void {
    this.#client.on(RoomMemberEvent.Membership, (_event: SdkEvent, member: RoomMember) => {
      if (member.userId !== this.#userId || member.membership !== "invite") return;
      this.#log?.info?.("auto-joining room", { room_id: member.roomId });
      void this.#client.joinRoom(member.roomId).catch((e: unknown) => {
        this.#log?.warn?.("failed to auto-join", { room_id: member.roomId, error: String(e) });
      });
    });

    this.#client.on(
      RoomEvent.Timeline,
      (event: SdkEvent, room: Room | undefined, toStartOfTimeline: boolean | undefined, _removed, data) => {
        if (toStartOfTimeline === true || room === undefined) return;
        if (data?.timeline?.getPaginationToken(Direction.Backward) !== undefined && data.liveEvent !== true) {
          return;
        }
        if (data?.liveEvent === false) return;
        this.#push(event.getEffectiveEvent(), room.roomId);
      },
    );
  }

  #push(raw: RawEvent, roomId: string): void {
    const normalized = normalizeEvent(raw, roomId, this.#userId);
    if (normalized === undefined) return;
    this.#pending.push(normalized);
    this.#wake?.();
  }
}

export function awaitInitialSync(
  client: MatrixClient,
  timeoutMs: number = SYNC_START_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onSync = (state: SyncState, _previous: SyncState | null, data?: SyncStateData) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        detach();
        resolve();
        return;
      }
      if (state !== SyncState.Error && state !== SyncState.Stopped) return;
      detach();
      reject(syncFailure(state, data));
    };
    const detach = () => {
      clearTimeout(timer);
      client.off(ClientEvent.Sync, onSync);
    };
    timer = setTimeout(() => {
      detach();
      reject(new Error(`the Matrix sync did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    client.on(ClientEvent.Sync, onSync);
  });
}

export function watchForSyncDeath(client: MatrixClient, onDeath: (fault: Error) => void): void {
  client.on(
    ClientEvent.Sync,
    (state: SyncState, _previous: SyncState | null, data?: SyncStateData) => {
      if (state !== SyncState.Stopped && !isTerminalMatrixError(data?.error)) return;
      onDeath(syncFailure(state, data));
    },
  );
}

export function isTerminalMatrixError(error: unknown): boolean {
  const code = errcodeOf(error);
  return code !== undefined && TERMINAL_ERRCODES.has(code);
}

function syncFailure(state: SyncState, data: SyncStateData | undefined): Error {
  const error = data?.error;
  const errcode = errcodeOf(error);
  if (errcode === "M_UNKNOWN_TOKEN") {
    return withErrcode(
      new Error("the homeserver rejected the Matrix credential (M_UNKNOWN_TOKEN)"),
      errcode,
    );
  }
  const detail = error === undefined ? "" : `: ${String(error)}`;
  const failure = new Error(`the Matrix sync entered ${state}${detail}`);
  return errcode === undefined ? failure : withErrcode(failure, errcode);
}

function withErrcode(error: Error, errcode: string): Error {
  return Object.assign(error, { errcode });
}

function errcodeOf(error: unknown): string | undefined {
  const code = (error as { errcode?: unknown } | null | undefined)?.errcode;
  return typeof code === "string" ? code : undefined;
}

function textContent(markdown: string): Record<string, unknown> & { body: string } {
  return {
    msgtype: "m.text",
    body: markdown,
    format: "org.matrix.custom.html",
    formatted_body: renderMarkdown(markdown),
  };
}

export function renderMarkdown(source: string): string {
  const escaped = source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  return escaped
    .replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>")
    .replaceAll("\n", "<br/>");
}
