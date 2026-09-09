import { readDurable, writeDurable, deleteDurable } from "../../storage/files.ts";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { threadDataDir } from "../../config/dirs.ts";

import type { GenerateResponse, SidecarRequest } from "../../llm/types.ts";
import type { AppliedCompactionWrite, ToolOutput } from "./types.ts";

const CHECKPOINT_FILE = "compaction-checkpoint.json";

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

export function checkpointPath(dataDir: string, character: string, thread: string): string {
  return join(threadDataDir(dataDir, character, thread), CHECKPOINT_FILE);
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
    raw = readDurable(checkpointPath(dataDir, character, thread));
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
    checkpointPath(dataDir, checkpoint.character, thread),
    JSON.stringify(persisted, null, 2),
  );
}

export async function removeCompactionCheckpoint(
  dataDir: string,
  character: string,
  thread: string,
): Promise<void> {
  try {
    deleteDurable(checkpointPath(dataDir, character, thread));
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
