export interface PlacementTurn {
  role: "user" | "assistant" | "system";
  toolResultOnly: boolean;
}

export function assistantTurnStart(turns: readonly PlacementTurn[]): number {
  let lastAssistant = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return turns.length;

  let start = lastAssistant;
  while (start > 0) {
    const previous = turns[start - 1];
    if (previous === undefined) break;
    if (previous.role === "assistant" || previous.toolResultOnly) {
      start -= 1;
      continue;
    }
    break;
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
