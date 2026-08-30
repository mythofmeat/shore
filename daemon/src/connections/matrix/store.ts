import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { shoreLog } from "../../log.ts";

export interface Sidecar<T> {
  read(): T;
  write(value: T): void;
}

function isMissing(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "ENOENT";
}

function quarantine(path: string, reason: string): void {
  const aside = `${path}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(path, aside);
    shoreLog.warn(
      `shore: ${path} was unreadable (${reason}); moved to ${aside} and starting from empty`,
    );
  } catch (e) {
    shoreLog.warn(
      `shore: ${path} was unreadable (${reason}) and could not be set aside: ${String(e)}`,
    );
  }
}

export function jsonSidecar<T>(path: string | undefined, fallback: () => T): Sidecar<T> {
  if (path === undefined) {
    let held = fallback();
    return {
      read: () => held,
      write: (value) => {
        held = value;
      },
    };
  }

  return {
    read: () => {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (e) {
        if (!isMissing(e)) quarantine(path, String(e));
        return fallback();
      }
      try {
        return JSON.parse(raw) as T;
      } catch (e) {
        quarantine(path, String(e));
        return fallback();
      }
    },
    write: (value) => {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
      try {
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    },
  };
}
