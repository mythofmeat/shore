import { createHash } from "node:crypto";

const FINGERPRINT_CHARS = 16;

export function toolSurfaceFingerprint(tools: readonly unknown[] | undefined): string | undefined {
  if (tools === undefined) return undefined;
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, FINGERPRINT_CHARS);
}
