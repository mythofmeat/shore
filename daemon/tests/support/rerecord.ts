import { appendFileSync } from "node:fs";

const OUT = process.env["SHORE_RERECORD"];

export const recording = OUT !== undefined && OUT !== "";

export function recordedValue(capture: string, pointer: readonly (string | number)[], actual: unknown): void {
  if (!recording) return;
  appendFileSync(
    OUT as string,
    `${JSON.stringify({ capture, pointer, value: JSON.parse(JSON.stringify(actual)) as unknown })}\n`,
  );
}
