import { threadFile, readDurable, writeDurable, deleteDurable } from "../../storage/files.ts";
import { createHash, randomUUID } from "node:crypto";

import type { GenerateResponse, SidecarRequest } from "../../llm/types.ts";
import type { AppliedCompactionWrite, ToolOutput } from "./types.ts";

export type CompactionPauseReason =
  | "budget"
  | "provider"
  | "iteration_limit"
  | "source_conflict"
  | "workspace_conflict";

export interface CheckpointLoopState {
  writesApplied: AppliedCompactionWrite[];
  toolsCalled: string[];
  dryRunPreviews: { path: string; content: string }[];
  toolRounds: number;
  maxRoundsHit: boolean;
  dryRun: boolean;
  pendingTurn?: GenerateResponse;
  pendingResults: ToolOutput[];
  pendingUseCount: number;
  pendingNote?: string;
}

export interface CompactionCheckpoint {
  version: 1;
  id: string;
  character: string;
  createdAt: string;
  updatedAt: string;
  state: "running" | "paused";
  pauseReason?: CompactionPauseReason;
  pauseDetail?: string;
  resumeAt?: string;
  sourceContent: string;
  sourceHash: string;
  splitAt: number;
  compactedTurns: number;
  memoryBefore?: string;
  coverageClaim?: string;
  request: SidecarRequest;
  loop: CheckpointLoopState;
}

export function hashCompactionSource(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function newCompactionCheckpoint(
  character: string,
  sourceContent: string,
  splitAt: number,
  compactedTurns: number,
  request: SidecarRequest,
  dryRun: boolean,
  memoryBefore?: string,
  now: () => Date = () => new Date(),
): CompactionCheckpoint {
  const at = now().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    character,
    createdAt: at,
    updatedAt: at,
    state: "running",
    sourceContent,
    sourceHash: hashCompactionSource(sourceContent),
    splitAt,
    compactedTurns,
    ...(memoryBefore === undefined ? {} : { memoryBefore }),
    request,
    loop: {
      writesApplied: [],
      toolsCalled: [],
      dryRunPreviews: [],
      toolRounds: 0,
      maxRoundsHit: false,
      dryRun,
      pendingResults: [],
      pendingUseCount: 0,
    },
  };
}

export async function loadCompactionCheckpoint(
  dataDir: string,
  character: string,
  thread: string,
): Promise<CompactionCheckpoint | undefined> {
  let raw: string;
  try {
    raw = readDurable(threadFile(dataDir, character, thread, "compaction-checkpoint.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const parsed = JSON.parse(raw) as Partial<CompactionCheckpoint>;
  if (
    parsed.version !== 1 ||
    parsed.character !== character ||
    typeof parsed.id !== "string" ||
    typeof parsed.sourceContent !== "string" ||
    typeof parsed.sourceHash !== "string" ||
    typeof parsed.splitAt !== "number" ||
    parsed.request === undefined ||
    parsed.loop === undefined
  ) {
    throw new Error(`invalid compaction checkpoint for ${character}`);
  }
  parsed.request.api_key = "";
  return parsed as CompactionCheckpoint;
}

export async function saveCompactionCheckpoint(
  dataDir: string,
  checkpoint: CompactionCheckpoint,
  thread: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  checkpoint.updatedAt = now().toISOString();
  const persisted = { ...checkpoint, request: withoutCredential(checkpoint.request) };
  writeDurable(
    threadFile(dataDir, checkpoint.character, thread, "compaction-checkpoint.json"),
    JSON.stringify(persisted, null, 2),
  );
}

export async function removeCompactionCheckpoint(
  dataDir: string,
  character: string,
  thread: string,
): Promise<void> {
  try {
    deleteDurable(threadFile(dataDir, character, thread, "compaction-checkpoint.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function checkpointSourceIsCompatible(
  checkpoint: CompactionCheckpoint,
  activeContent: string,
): boolean {
  return (
    hashCompactionSource(checkpoint.sourceContent) === checkpoint.sourceHash &&
    activeContent.startsWith(checkpoint.sourceContent)
  );
}

function withoutCredential(request: SidecarRequest): SidecarRequest {
  return { ...request, api_key: "" };
}
