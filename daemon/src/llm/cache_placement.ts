export interface PlacementTurn {
  role: "user" | "assistant" | "system";
  toolResultOnly: boolean;
}

export function assistantTurnStart(turns: readonly PlacementTurn[]): number {
  const last = turns.findLastIndex((turn) => turn.role === "assistant");
  if (last === -1) return turns.length;
  let start = last;
  for (let i = last - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role !== "assistant" && turn?.toolResultOnly !== true) break;
    start = i;
  }
  return start;
}

function frozenBoundaryBefore(turns: readonly PlacementTurn[]): number {
  return assistantTurnStart(turns) - 1;
}

export function messageBreakpoints(turns: readonly PlacementTurn[]): number[] {
  if (turns.length === 0) return [];

  const newestTurn = turns.length - 1;
  const anchors = [newestTurn];

  const frozen = frozenBoundaryBefore(turns);
  if (frozen >= 0) {
    anchors.push(frozen);
    const previouslyFrozen = frozenBoundaryBefore(turns.slice(0, frozen));
    if (previouslyFrozen + 1 < frozen && previouslyFrozen >= 0) anchors.push(previouslyFrozen);
  }

  return [...new Set(anchors)].sort((a, b) => a - b);
}
