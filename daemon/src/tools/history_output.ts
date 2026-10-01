import type { HistoryCloseness, HistoryHit, HistoryLocation, HistoryMessage, SearchHistoryResult } from "./history.ts";

function key(message: HistoryLocation): string {
  return JSON.stringify([message.thread, message.segment, message.ordinal]);
}

export function historyText(value: SearchHistoryResult): string {
  const lines = [`Chat history: ${value.count} matches (${value.mode}; ${value.time_zone})`];
  if (value.match === "phrase") lines.push("Matching: whole phrase with word boundaries; no semantic expansion.");
  if (value.match === "nearest") lines.push("Matching: nearest messages, including weak matches.");
  if (value.compact) lines.push("Showing matching excerpts without neighboring messages; request full context for relevant hits.");
  if (value.query !== null) lines.push(`Query: ${JSON.stringify(value.query)}`);
  if (value.model_filter !== null) lines.push(`Model filter: ${JSON.stringify(value.model_filter)}`);
  const range = value.time_range;
  if (range.start_time || range.end_time) lines.push(`Range: ${range.start_time ?? "earliest"} to ${range.end_time ?? "latest"} (inclusive)`);
  const boundary = value.archive_boundary;
  lines.push(`Archive: ${boundary.oldest ?? "empty"} to ${boundary.newest ?? "empty"}; now: ${value.now}`);
  const closeness = value.closeness;
  if (value.count === 0 && closeness?.weaker_left_out === true) {
    lines.push(`No close matches in archived messages: ${whyNotClose(closeness)}. match: nearest returns the nearest weak matches.`);
    if (closeness.words.length >= 4) lines.push("Long queries match less well; two or three distinctive words work best.");
    lines.push("Active conversation messages are not searched.");
  } else if (value.count === 0) {
    lines.push("No matches in archived messages. Active conversation messages are not searched.");
  } else if (closeness?.weaker_left_out === true) {
    lines.push("Close matches only; weaker matches were left out (match: nearest includes them).");
  }
  if (value.semantic_unavailable) lines.push(`Semantic search unavailable: ${value.semantic_unavailable}`);
  if (value.semantic_index.pending_chunks) lines.push(`${value.semantic_index.pending_chunks} chunks pending semantic indexing.`);
  if (value.skipped_invalid_timestamps) lines.push(`${value.skipped_invalid_timestamps} messages skipped because of invalid timestamps.`);
  if (value.has_more) lines.push("More matches available. Increase max_results (up to 50) or narrow query/time range/model.");

  const hits = value.results as unknown as HistoryHit[];
  const matched = new Map(hits.map((hit) => [key(hit), hit]));
  const groups: Map<string, HistoryMessage>[] = [];
  for (const hit of hits) {
    const incoming = new Map([...hit.before, hit, ...hit.after].map((message) => [key(message), message]));
    let first: Map<string, HistoryMessage> | undefined;
    for (let index = 0; index < groups.length;) {
      const group = groups[index];
      if (group !== undefined && [...group.keys()].some((id) => incoming.has(id))) {
        if (first === undefined) {
          first = group;
          for (const [id, message] of incoming) group.set(id, message);
          index += 1;
        } else {
          for (const [id, message] of group) first.set(id, message);
          groups.splice(index, 1);
        }
      } else {
        index += 1;
      }
    }
    if (first === undefined) groups.push(incoming);
  }
  for (const group of groups) {
    const messages = [...group.values()].sort((a, b) => a.segment - b.segment || a.ordinal - b.ordinal);
    lines.push("", `Thread ${JSON.stringify(messages[0]?.thread)}`);
    for (const message of messages) {
      const hit = matched.get(key(message));
      const source = `${message.segment}:${message.ordinal} id=${JSON.stringify(message.msg_id)}`;
      lines.push("", `[${message.timestamp} ${message.role}${message.model ? ` (${message.model})` : ""}${hit ? matchLabel(hit) : ""}; ${source}]`, message.text);
      if (hit && hit.locations.length > 1) {
        lines.push(`Also archived at: ${hit.locations.filter((location) => key(location) !== key(message)).map((location) => `${JSON.stringify(location.thread)} ${location.segment}:${location.ordinal}`).join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

function matchLabel(hit: HistoryHit): string {
  const label = hit.weak === true ? " — weak match" : " — match";
  return hit.similarity === undefined ? label : `${label}, similarity ${hit.similarity.toFixed(2)}`;
}

export function whyNotClose(closeness: HistoryCloseness, noun = "message"): string {
  const words = `no ${noun} contains all of: ${closeness.words.join(", ")}`;
  if (closeness.best_similarity === null || closeness.min_similarity === null) return words;
  return `${words}, and the best similarity is ${closeness.best_similarity.toFixed(2)} (close needs ${closeness.min_similarity.toFixed(2)})`;
}
