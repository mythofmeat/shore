export type MatrixEvent =
  | {
      readonly kind: "message";
      readonly roomId: string;
      readonly sender: string;
      readonly eventId: string;
      readonly text: string;
    }
  | {
      readonly kind: "image";
      readonly roomId: string;
      readonly sender: string;
      readonly eventId: string;
      readonly url: string;
      readonly body: string;
      readonly mimeType: string | undefined;
    }
  | {
      readonly kind: "edit";
      readonly roomId: string;
      readonly sender: string;
      readonly targetEventId: string;
      readonly newText: string;
    }
  | {
      readonly kind: "redaction";
      readonly roomId: string;
      readonly sender: string;
      readonly redacts: string;
    }
  | {
      readonly kind: "reaction";
      readonly roomId: string;
      readonly sender: string;
      readonly targetEventId: string;
      readonly key: string;
    };

export interface RawEvent {
  readonly type?: string;
  readonly event_id?: string;
  readonly sender?: string;
  readonly room_id?: string;
  readonly redacts?: string;
  readonly content?: Record<string, unknown>;
}

export function normalizeEvent(
  raw: RawEvent,
  roomId: string,
  selfUserId: string,
): MatrixEvent | undefined {
  const sender = raw.sender;
  if (sender === undefined || sender === selfUserId) return undefined;
  const content = raw.content ?? {};

  switch (raw.type) {
    case "m.room.message":
      return normalizeMessage(raw, content, roomId, sender);
    case "m.reaction":
      return normalizeReaction(content, roomId, sender);
    case "m.room.redaction": {
      const redacts = raw.redacts ?? str(content, "redacts");
      if (redacts === undefined) return undefined;
      return { kind: "redaction", roomId, sender, redacts };
    }
    default:
      return undefined;
  }
}

function normalizeMessage(
  raw: RawEvent,
  content: Record<string, unknown>,
  roomId: string,
  sender: string,
): MatrixEvent | undefined {
  const replacement = replacementTarget(content);
  if (replacement !== undefined) {
    const fresh = record(content, "m.new_content");
    const newText = fresh === undefined ? undefined : str(fresh, "body");
    if (newText === undefined || str(fresh ?? {}, "msgtype") !== "m.text") return undefined;
    return { kind: "edit", roomId, sender, targetEventId: replacement, newText };
  }

  const eventId = raw.event_id;
  if (eventId === undefined) return undefined;
  const body = str(content, "body") ?? "";

  switch (str(content, "msgtype")) {
    case "m.text":
      return { kind: "message", roomId, sender, eventId, text: body };
    case "m.image": {
      const url = str(content, "url");
      if (url === undefined) return undefined;
      return {
        kind: "image",
        roomId,
        sender,
        eventId,
        url,
        body,
        mimeType: str(record(content, "info") ?? {}, "mimetype"),
      };
    }
    default:
      return undefined;
  }
}

function normalizeReaction(
  content: Record<string, unknown>,
  roomId: string,
  sender: string,
): MatrixEvent | undefined {
  const relates = record(content, "m.relates_to");
  if (relates === undefined) return undefined;
  const targetEventId = str(relates, "event_id");
  const key = str(relates, "key");
  if (targetEventId === undefined || key === undefined) return undefined;
  return { kind: "reaction", roomId, sender, targetEventId, key };
}

function replacementTarget(content: Record<string, unknown>): string | undefined {
  const relates = record(content, "m.relates_to");
  if (relates === undefined || str(relates, "rel_type") !== "m.replace") return undefined;
  return str(relates, "event_id");
}

export function sanitizeFilename(body: string): string {
  const name = (body.split(/[/\\]/).pop() ?? "").trim();
  return name === "" || name === "." || name === ".." ? "image" : name;
}

function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function record(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
