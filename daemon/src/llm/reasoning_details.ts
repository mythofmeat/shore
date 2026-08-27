import type { ReasoningDetailUnion } from "@openrouter/sdk/models";

export function appendReasoningDetails(
  accumulated: ReasoningDetailUnion[],
  incoming: ReasoningDetailUnion[],
): void {
  for (const detail of incoming) {
    const previous = accumulated.at(-1);

    if (detail.type === "reasoning.text" && previous?.type === "reasoning.text") {
      previous.text = (previous.text ?? "") + (detail.text ?? "");
      previous.signature = previous.signature || detail.signature;
      previous.format = previous.format || detail.format;
      continue;
    }

    if (detail.type === "reasoning.summary" && previous?.type === "reasoning.summary") {
      previous.summary = (previous.summary ?? "") + (detail.summary ?? "");
      previous.format = previous.format || detail.format;
      continue;
    }

    accumulated.push({ ...detail });
  }
}
