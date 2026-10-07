import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type SpeakerRole = "user" | "assistant";

const DISPLAY_OTHER = 0;
const DISPLAY_ASSISTANT = 1;
const DISPLAY_TOOL_ASSISTANT = 2;
const DISPLAY_TOOL_RESULT = 3;

export interface RestoreSummary {
  matched: number;
  user: number;
  assistant: number;
  unmatched: number;
  characters: string[];
}

function chatFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function parseRecord(raw: string): Record<string, unknown> | undefined {
  const line = raw.trim();
  if (line === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function idPrefix(label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return `m_import_${safe}_`;
}

export function sillyTavernRoles(chatsDir: string, label = "sillytavern"): Map<string, SpeakerRole> {
  const prefix = idPrefix(label);
  const roles = new Map<string, SpeakerRole>();
  for (const path of chatFiles(chatsDir)) {
    const rel = relative(chatsDir, path);
    readFileSync(path, "utf8").split(/\r\n|\r|\n/).forEach((raw, index) => {
      const record = parseRecord(raw);
      if (record === undefined || "chat_metadata" in record || record["is_system"] !== true) return;
      const text = record["mes"];
      const isUser = record["is_user"];
      if (typeof text !== "string" || typeof isUser !== "boolean" || text.trim() === "") return;
      const digest = createHash("sha1")
        .update(`${label}\0${rel}\0${String(index + 1)}\0system\0${text}`)
        .digest("hex")
        .slice(0, 24);
      roles.set(`${prefix}${digest}`, isUser ? "user" : "assistant");
    });
  }
  return roles;
}

export function restoreRoles(
  db: Database,
  roles: ReadonlyMap<string, SpeakerRole>,
  apply: boolean,
  label = "sillytavern",
): RestoreSummary {
  const imported = db
    .query("SELECT id, character, segment, ordinal, msg_id FROM history_messages WHERE role = 'system' AND substr(msg_id, 1, ?2) = ?1")
    .all(idPrefix(label), idPrefix(label).length) as { id: number; character: string; segment: number; ordinal: number; msg_id: string }[];
  const previous = db.query(
    `SELECT display_kind, display_seq FROM history_messages
     WHERE character = ?1 AND (segment < ?2 OR (segment = ?2 AND ordinal < ?3))
     ORDER BY segment DESC, ordinal DESC LIMIT 1`,
  );
  const targets = imported.flatMap((row) => {
    const role = roles.get(row.msg_id);
    if (role === undefined) return [];
    const before = previous.get(row.character, row.segment, row.ordinal) as { display_kind: number; display_seq: number | null } | null;
    if (before !== null && before.display_seq !== null && (before.display_kind === DISPLAY_TOOL_ASSISTANT || before.display_kind === DISPLAY_TOOL_RESULT)) {
      throw new Error(`${row.msg_id} follows a tool message, so changing its role would regroup the display rows after it`);
    }
    return [{ ...row, role }];
  });
  const characters = [...new Set(targets.map((row) => row.character))].sort();
  if (apply) {
    const update = db.query("UPDATE history_messages SET role = ?2, display_kind = ?3, is_user_turn = ?4 WHERE id = ?1");
    const bump = db.query(
      `INSERT INTO history_archive_revision(character, revision) VALUES (?1, 1)
       ON CONFLICT(character) DO UPDATE SET revision = revision + 1`,
    );
    db.transaction(() => {
      for (const row of targets) {
        update.run(row.id, row.role, row.role === "user" ? DISPLAY_OTHER : DISPLAY_ASSISTANT, row.role === "user" ? 1 : 0);
      }
      for (const character of characters) bump.run(character);
    })();
  }
  const user = targets.filter((row) => row.role === "user").length;
  return {
    matched: targets.length,
    user,
    assistant: targets.length - user,
    unmatched: imported.length - targets.length,
    characters,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const labelAt = args.indexOf("--label");
  const label = labelAt === -1 ? "sillytavern" : args[labelAt + 1];
  const [dbPath, chatsDir] = args.filter((arg, i) => !arg.startsWith("--") && (labelAt === -1 || i !== labelAt + 1));
  if (dbPath === undefined || chatsDir === undefined || label === undefined) {
    console.error("usage: bun run scripts/restore_sillytavern_roles.ts <shore.db> <sillytavern-chats-dir> [--label sillytavern] [--apply]");
    process.exit(2);
  }
  const db = apply ? new Database(dbPath, { readwrite: true }) : new Database(dbPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000;");
    const summary = restoreRoles(db, sillyTavernRoles(chatsDir, label), apply, label);
    console.log(`${String(summary.matched)} imported system messages match their source: ${String(summary.user)} user, ${String(summary.assistant)} character.`);
    if (summary.unmatched > 0) console.log(`${String(summary.unmatched)} imported system messages have no match in ${chatsDir} and stay system.`);
    console.log(apply ? `Restored. Bumped the archive revision for: ${summary.characters.join(", ") || "nothing"}.` : "Dry run; pass --apply to write.");
  } finally {
    db.close();
  }
}
