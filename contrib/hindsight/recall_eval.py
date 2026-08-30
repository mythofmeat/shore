"""Collect and review Hindsight recall quality against real shore turns.

The collector replays archived user turns without modifying either shore's
history or the Hindsight bank. The review step produces a CSV for lightweight
human labels; the report compares query variants and top-3/top-6 cutoffs, and
prints the reranker-score distribution per label so a `min_scores` floor can be
calibrated rather than guessed.

The rewrite variants send recent dialogue to a small instruct model that resolves
references without interpreting them. It is deliberately given no character or
personality prompt: its output feeds retrieval, not the reply.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MESSAGE_CHARS = 1_200
TRANSCRIPT_RESULTS = 12
LABELS = {"", "useful", "harmless", "distracting"}
VARIANTS = {"user", "assistant_tail", "recent", "rewrite_replace", "rewrite_augment"}
REWRITE_VARIANTS = {"rewrite_replace", "rewrite_augment"}
CONTEXT_TURNS = 4

REVIEW_FIELDS = [
    "case_id",
    "timestamp",
    "variant",
    "elapsed_ms",
    "error",
    "query",
    "user_text",
    "assistant_context",
    "rank",
    "id",
    "type",
    "final",
    "reranker",
    "semantic",
    "keyword",
    "text",
    "label",
]


def message_text(data: bytes, compressed: int) -> str:
    if compressed:
        try:
            import zstandard
        except ModuleNotFoundError as error:
            raise RuntimeError(
                "compressed history requires the dependencies in requirements.txt"
            ) from error
        raw = zstandard.ZstdDecompressor().decompress(data)
    else:
        raw = data
    blocks = json.loads(raw)
    return " ".join(
        block.get("text", "")
        for block in blocks
        if isinstance(block, dict) and isinstance(block.get("text", ""), str)
    ).strip()


def archived_turns(history: str, character: str, since: str = "") -> list[dict]:
    db = sqlite3.connect(f"file:{history}?mode=ro", uri=True)
    try:
        rows = db.execute(
            """SELECT m.segment, m.ordinal, m.timestamp, m.role, b.data, b.compressed
                 FROM history_messages m
                 JOIN history_segments s
                   ON s.character = m.character AND s.idx = m.segment
                 JOIN history_blobs b ON b.hash = m.blocks_hash
                WHERE m.character = ? AND s.committed = 1 AND s.excluded = 0
                ORDER BY m.segment, m.ordinal""",
            (character,),
        ).fetchall()
    finally:
        db.close()

    turns: list[dict] = []
    previous_role = ""
    previous_text = ""
    history: list[dict] = []
    for segment, ordinal, timestamp, role, data, compressed in rows:
        text = message_text(data, compressed)
        if not text:
            continue
        if role == "user" and (not since or timestamp[:10] >= since):
            turns.append(
                {
                    "case_id": f"seg{segment}:m{ordinal}",
                    "timestamp": timestamp,
                    "user_text": text,
                    "assistant_context": previous_text if previous_role == "assistant" else "",
                    "recent_dialogue": history[-CONTEXT_TURNS:],
                }
            )
        if role in {"user", "assistant"}:
            previous_role = role
            previous_text = text
            history.append({"role": role, "text": text})
    return turns


def dialogue_block(turn: dict, user_name: str, character: str) -> str:
    lines = []
    for message in turn.get("recent_dialogue", []):
        speaker = user_name if message.get("role") == "user" else character
        lines.append(f"{speaker}: {message.get('text', '').strip()[:MESSAGE_CHARS]}")
    return "\n".join(lines)


REPLACE_INSTRUCTION = (
    "You prepare search queries for a memory database. Rewrite the final message "
    "as one standalone search query describing what should be retrieved.\n"
    "Preserve every name, place, date, quoted phrase, and unusual term that "
    "appears in the conversation.\n"
    "Do not answer the message. Do not roleplay. Do not invent facts that the "
    "conversation does not establish.\n"
    "Output only the query."
)

AUGMENT_INSTRUCTION = (
    "You prepare search queries for a memory database. The final message is kept "
    "verbatim; your job is to supply the context it omits.\n"
    "Write one or two sentences resolving pronouns, ellipses, and references so "
    "the message can be understood on its own.\n"
    "Preserve every name, place, date, quoted phrase, and unusual term that "
    "appears in the conversation.\n"
    "Do not answer the message. Do not roleplay. Do not infer motivations, "
    "beliefs, or any fact the conversation does not establish. If the context is "
    "genuinely unclear, say only what is established.\n"
    "Output only those sentences."
)


def chat(url: str, model: str, api_key: str | None, instruction: str, content: str, timeout: float) -> str:
    """Ask the rewrite model for one short completion.

    `thinking` is disabled because these prompts are short enough that a reasoning
    model spends the whole completion budget on reasoning tokens and returns empty
    content with finish_reason=length. Endpoints that do not know the field ignore
    it; ZAI, the default target, needs it.
    """
    body = json.dumps(
        {
            "model": model,
            "temperature": 0,
            "max_tokens": 400,
            "thinking": {"type": "disabled"},
            "messages": [
                {"role": "system", "content": instruction},
                {"role": "user", "content": content},
            ],
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "shore-recall-eval/1"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    endpoint = f"{url.rstrip('/')}/chat/completions"
    request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.load(response)
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError(f"rewrite model returned no choices: {str(payload)[:200]}")
    text = (choices[0].get("message", {}).get("content") or "").strip()
    if not text:
        finish = choices[0].get("finish_reason", "?")
        raise RuntimeError(
            f"rewrite model returned empty content (finish_reason={finish}); "
            "a reasoning model may have spent the whole completion on thinking"
        )
    return text


def rewrite_variants(
    turn: dict, wanted: set[str], args: argparse.Namespace
) -> tuple[dict[str, str], dict[str, str]]:
    user = turn["user_text"].strip()[:MESSAGE_CHARS]
    block = dialogue_block(turn, args.user_name, args.character)
    content = f"Conversation so far:\n{block}\n\nFinal message:\n{user}"
    queries: dict[str, str] = {}
    errors: dict[str, str] = {}
    if "rewrite_replace" in wanted:
        try:
            rewritten = chat(
                args.rewrite_url, args.rewrite_model, args.rewrite_key,
                REPLACE_INSTRUCTION, content, args.rewrite_timeout,
            )
            queries["rewrite_replace"] = rewritten
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as error:
            queries["rewrite_replace"] = user
            errors["rewrite_replace"] = f"rewrite failed, fell back to raw: {error}"
    if "rewrite_augment" in wanted:
        try:
            context = chat(
                args.rewrite_url, args.rewrite_model, args.rewrite_key,
                AUGMENT_INSTRUCTION, content, args.rewrite_timeout,
            )
            queries["rewrite_augment"] = f"{user}\n\nContext: {context}"
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as error:
            queries["rewrite_augment"] = user
            errors["rewrite_augment"] = f"rewrite failed, fell back to raw: {error}"
    return queries, errors


def query_variants(turn: dict, assistant_chars: int) -> dict[str, str]:
    user = turn["user_text"].strip()[:MESSAGE_CHARS]
    assistant = turn["assistant_context"].strip()
    tail = assistant[-assistant_chars:] if assistant_chars > 0 else ""
    recent_assistant = assistant[:MESSAGE_CHARS]
    return {
        "user": user,
        "assistant_tail": f"{tail}\n\n{user}" if tail else user,
        "recent": f"{recent_assistant}\n\n{user}" if recent_assistant else user,
    }


def recall(
    base_url: str,
    bank: str,
    query: str,
    timestamp: str,
    max_tokens: int,
    timeout: float,
    api_key: str | None,
) -> dict:
    endpoint = (
        f"{base_url.rstrip('/')}/v1/default/banks/"
        f"{urllib.parse.quote(bank, safe='')}/memories/recall"
    )
    body = json.dumps(
        {"query": query, "query_timestamp": timestamp, "max_tokens": max_tokens}
    ).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "shore-recall-eval/1"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def scored_result(raw: object) -> dict | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("text"), str):
        return None
    result = {
        key: raw[key]
        for key in ("id", "text", "type", "occurred_start")
        if key in raw
    }
    scores = raw.get("scores")
    if isinstance(scores, dict):
        result["scores"] = {
            key: scores[key]
            for key in ("final", "reranker", "semantic", "keyword")
            if key in scores and (scores[key] is None or isinstance(scores[key], (int, float)))
        }
    return result


def collect(args: argparse.Namespace) -> int:
    if args.limit <= 0:
        raise ValueError("--limit must be greater than zero")
    if args.max_tokens <= 0:
        raise ValueError("--max-tokens must be greater than zero")
    if args.timeout <= 0:
        raise ValueError("--timeout must be greater than zero")
    if args.assistant_chars < 0:
        raise ValueError("--assistant-chars cannot be negative")
    wanted = [value.strip() for value in args.variants.split(",") if value.strip()]
    if not wanted:
        raise ValueError("--variants must name at least one query variant")
    unknown = sorted(set(wanted) - VARIANTS)
    if unknown:
        raise ValueError(f"unknown variant(s): {', '.join(unknown)}")
    args.rewrite_key = os.environ.get(args.rewrite_key_env, "")
    if set(wanted) & REWRITE_VARIANTS and not args.rewrite_key:
        raise ValueError(f"{args.rewrite_key_env} is not set; the rewrite variants need it")
    turns = archived_turns(args.history, args.character, args.since)
    turns = turns[-args.limit :]
    if not turns:
        print("no archived user turns matched", file=sys.stderr)
        return 1

    output, close = output_stream(args.output)
    try:
        for index, turn in enumerate(turns, 1):
            variants = query_variants(turn, args.assistant_chars)
            rewrite_wanted = set(wanted) & REWRITE_VARIANTS
            rewrite_errors: dict[str, str] = {}
            if rewrite_wanted:
                rewritten, rewrite_errors = rewrite_variants(turn, rewrite_wanted, args)
                variants.update(rewritten)
            calls: dict[str, dict] = {}
            for variant in wanted:
                started = time.perf_counter()
                try:
                    payload = recall(
                        args.url,
                        args.character,
                        variants[variant],
                        turn["timestamp"],
                        args.max_tokens,
                        args.timeout,
                        args.api_key,
                    )
                    raw_results = payload.get("results", []) if isinstance(payload, dict) else []
                    results = [
                        parsed
                        for raw in raw_results
                        if (parsed := scored_result(raw)) is not None
                    ]
                    calls[variant] = {
                        "query": variants[variant],
                        "elapsed_ms": round((time.perf_counter() - started) * 1_000),
                        "returned": len(results),
                        "results": results[:TRANSCRIPT_RESULTS],
                        "results_truncated": len(results) > TRANSCRIPT_RESULTS,
                        **({"error": rewrite_errors[variant]} if variant in rewrite_errors else {}),
                    }
                except (OSError, ValueError, urllib.error.HTTPError) as error:
                    calls[variant] = {
                        "query": variants[variant],
                        "elapsed_ms": round((time.perf_counter() - started) * 1_000),
                        "returned": 0,
                        "results": [],
                        "results_truncated": False,
                        "error": str(error),
                    }
            output.write(json.dumps({**turn, "variants": calls}, ensure_ascii=False) + "\n")
            output.flush()
            print(f"{index}/{len(turns)} {turn['case_id']}", file=sys.stderr, flush=True)
    finally:
        if close:
            output.close()
    return 0


def review_rows(cases: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for case in cases:
        for variant, call in case.get("variants", {}).items():
            common = {
                "case_id": case.get("case_id", ""),
                "timestamp": case.get("timestamp", ""),
                "variant": variant,
                "elapsed_ms": call.get("elapsed_ms", ""),
                "error": call.get("error", ""),
                "query": call.get("query", ""),
                "user_text": case.get("user_text", ""),
                "assistant_context": case.get("assistant_context", ""),
            }
            results = call.get("results", [])
            if not results:
                rows.append({**common, "rank": 0, "label": ""})
                continue
            for rank, result in enumerate(results, 1):
                scores = result.get("scores") or {}
                rows.append(
                    {
                        **common,
                        "rank": rank,
                        "id": result.get("id", ""),
                        "type": result.get("type", ""),
                        "final": scores.get("final", ""),
                        "reranker": scores.get("reranker", ""),
                        "semantic": scores.get("semantic", ""),
                        "keyword": scores.get("keyword", ""),
                        "text": result.get("text", ""),
                        "label": "",
                    }
                )
    return rows


def review(args: argparse.Namespace) -> int:
    cases = read_jsonl(args.input)
    output, close = output_stream(args.output)
    try:
        writer = csv.DictWriter(output, fieldnames=REVIEW_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(review_rows(cases))
    finally:
        if close:
            output.close()
    return 0


def percentile(values: list[int], fraction: float) -> int:
    ordered = sorted(values)
    if not ordered:
        return 0
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def ratio(numerator: int, denominator: int) -> str:
    return "n/a" if denominator == 0 else f"{100 * numerator / denominator:.0f}%"


def report_text(rows: list[dict]) -> str:
    grouped: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        label = row.get("label", "").strip().lower()
        if label not in LABELS:
            raise ValueError(
                f"invalid label {row.get('label')!r} for {row.get('case_id')} "
                f"{row.get('variant')} rank {row.get('rank')}"
            )
        row["label"] = label
        grouped.setdefault((row.get("case_id", ""), row.get("variant", "")), []).append(row)

    lines = [
        "Labels: useful = should be injected; harmless = irrelevant but benign; "
        "distracting = likely to pull the reply off course.",
        "",
    ]
    variants = sorted({variant for _, variant in grouped})
    for variant in variants:
        cases = [items for (_, name), items in grouped.items() if name == variant]
        latencies = [
            int(float(items[0].get("elapsed_ms") or 0))
            for items in cases
            if items and items[0].get("elapsed_ms") not in (None, "")
        ]
        errors = sum(bool(items and items[0].get("error")) for items in cases)
        complete = [
            items
            for items in cases
            if not (items and items[0].get("error"))
            and all(
                row.get("label")
                for row in items
                if 0 < int(row.get("rank") or 0) <= 6
            )
        ]
        labelled = sum(
            bool(row.get("label"))
            for items in cases
            for row in items
            if int(row.get("rank") or 0) > 0
        )
        results = sum(
            int(row.get("rank") or 0) > 0 for items in cases for row in items
        )
        lines.extend(
            [
                f"[{variant}]",
                f"cases={len(cases)} errors={errors} "
                f"latency_p50={percentile(latencies, 0.50)}ms "
                f"latency_p95={percentile(latencies, 0.95)}ms",
                f"labels={labelled}/{results} complete_top6_cases={len(complete)}/{len(cases)}",
            ]
        )
        for cutoff in (1, 3, 6):
            useful_hits = useful_lines = distracting_lines = 0
            for items in complete:
                selected = [
                    row
                    for row in items
                    if 0 < int(row.get("rank") or 0) <= cutoff
                ]
                useful = sum(row.get("label") == "useful" for row in selected)
                useful_hits += useful > 0
                useful_lines += useful
                distracting_lines += sum(
                    row.get("label") == "distracting" for row in selected
                )
            denominator = len(complete)
            lines.append(
                f"top{cutoff}: useful_hit={ratio(useful_hits, denominator)} "
                f"useful_lines/turn={useful_lines / denominator:.2f} "
                f"distracting_lines/turn={distracting_lines / denominator:.2f}"
                if denominator
                else f"top{cutoff}: no completely labelled cases"
            )
        added = 0
        only = 0
        for items in complete:
            top3 = any(
                row.get("label") == "useful" and 0 < int(row.get("rank") or 0) <= 3
                for row in items
            )
            tail = any(
                row.get("label") == "useful" and 4 <= int(row.get("rank") or 0) <= 6
                for row in items
            )
            added += tail
            only += tail and not top3
        lines.append(
            f"ranks4-6: add_useful={ratio(added, len(complete))} "
            f"only_useful_hit={ratio(only, len(complete))}"
        )
        lines.append("")
    lines.extend(separation_lines(rows))
    lines.extend(threshold_lines(rows))
    return "\n".join(lines)


def separation_lines(rows: list[dict]) -> list[str]:
    """Compare variants on reranker score alone, before anything is labelled.

    A full archive run produces far more rows than anyone will label by hand.
    The top-1 reranker score already separates a query that found its subject
    from one that did not, so this narrows which variants are worth labelling.
    """
    best: dict[tuple[str, str], float] = {}
    for row in rows:
        score = score_of(row)
        rank = row.get("rank") or "0"
        if score is None or int(rank) != 1:
            continue
        best[(row.get("case_id", ""), row.get("variant", ""))] = score
    if not best:
        return ["[score separation, no labels needed]", "no rank-1 reranker scores found", ""]

    variants = sorted({variant for _, variant in best})
    baseline = {case: score for (case, variant), score in best.items() if variant == "user"}
    lines = [
        "[score separation, no labels needed]",
        f"{'variant':18} {'cases':>5} {'top1_p50':>9} {'top1_p90':>9} {'>=0.1':>6} {'beats_user':>10}",
    ]
    for variant in variants:
        scores = {case: score for (case, name), score in best.items() if name == variant}
        values = sorted(scores.values())
        shared = [case for case in scores if case in baseline] if variant != "user" else []
        wins = sum(scores[case] > baseline[case] for case in shared)
        beats = ratio(wins, len(shared)) if shared else "-"
        lines.append(
            f"{variant:18} {len(values):>5} {quantile(values, 0.50):>9.4g} "
            f"{quantile(values, 0.90):>9.4g} "
            f"{ratio(sum(v >= 0.1 for v in values), len(values)):>6} {beats:>10}"
        )
    lines.append("")
    return lines


THRESHOLD_LADDER = (0.001, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9)


def score_of(row: dict) -> float | None:
    raw = row.get("reranker", "")
    if raw in (None, ""):
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def quantile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def threshold_lines(rows: list[dict]) -> list[str]:
    """Reranker distribution per label, and what a min_scores floor would keep.

    Hindsight warns that reranker scores are not calibrated across queries, so
    the floor has to come from the labelled archive rather than from a few
    hand-picked probes.
    """
    by_label: dict[str, list[float]] = {}
    for row in rows:
        label = row.get("label", "").strip().lower()
        score = score_of(row)
        if label in {"useful", "harmless", "distracting"} and score is not None:
            by_label.setdefault(label, []).append(score)
    if not by_label:
        return ["[min_scores calibration]", "no labelled rows carry a reranker score", ""]

    lines = ["[min_scores calibration]"]
    for label in ("useful", "harmless", "distracting"):
        values = by_label.get(label, [])
        if not values:
            lines.append(f"{label:12} n=0")
            continue
        lines.append(
            f"{label:12} n={len(values):<4} "
            f"min={min(values):.4g} p10={quantile(values, 0.10):.4g} "
            f"p50={quantile(values, 0.50):.4g} p90={quantile(values, 0.90):.4g} "
            f"max={max(values):.4g}"
        )
    useful = by_label.get("useful", [])
    noise = by_label.get("distracting", []) + by_label.get("harmless", [])
    if useful and noise:
        lines.append("floor    kept_useful  kept_noise")
        for floor in THRESHOLD_LADDER:
            kept_u = sum(value >= floor for value in useful)
            kept_n = sum(value >= floor for value in noise)
            lines.append(
                f"{floor:<8.3f} {ratio(kept_u, len(useful)):<12} {ratio(kept_n, len(noise))}"
            )
        lines.append("pick the floor that keeps useful lines while dropping the rest.")
    lines.append("")
    return lines


def report(args: argparse.Namespace) -> int:
    with open(args.input, newline="", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    print(report_text(rows))
    return 0


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as source:
        return [json.loads(line) for line in source if line.strip()]


def output_stream(path: str):
    if path == "-":
        return sys.stdout, False
    return open(Path(path), "x", encoding="utf-8", newline=""), True


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    collect_cmd = commands.add_parser("collect", help="replay archived turns against Hindsight")
    collect_cmd.add_argument("--history", required=True, help="path to shore's history.db")
    collect_cmd.add_argument("--character", required=True, help="shore character and bank id")
    collect_cmd.add_argument("--url", default="http://127.0.0.1:8888", help="Hindsight base URL")
    collect_cmd.add_argument("--api-key", help="optional Hindsight bearer token")
    collect_cmd.add_argument("--limit", type=int, default=40, help="most recent user turns to replay")
    collect_cmd.add_argument("--since", default="", help="oldest user-turn date, YYYY-MM-DD")
    collect_cmd.add_argument("--max-tokens", type=int, default=2048)
    collect_cmd.add_argument("--timeout", type=float, default=10.0, help="per-recall timeout in seconds")
    collect_cmd.add_argument(
        "--variants",
        default="user,assistant_tail",
        help="comma-separated: user, assistant_tail, recent, rewrite_replace, rewrite_augment",
    )
    collect_cmd.add_argument(
        "--user-name", default="User", help="name for user lines shown to the rewrite model"
    )
    collect_cmd.add_argument(
        "--rewrite-url",
        default="https://api.z.ai/api/coding/paas/v4",
        help="OpenAI-compatible base URL for the rewrite variants",
    )
    collect_cmd.add_argument("--rewrite-model", default="glm-5.3-flash")
    collect_cmd.add_argument(
        "--rewrite-key-env",
        default="ZAI_API_KEY",
        help="environment variable holding the rewrite model's bearer token",
    )
    collect_cmd.add_argument("--rewrite-timeout", type=float, default=20.0)
    collect_cmd.add_argument(
        "--assistant-chars",
        type=int,
        default=200,
        help="preceding assistant tail used by assistant_tail",
    )
    collect_cmd.add_argument("--output", required=True, help="new JSONL file, or - for stdout")
    collect_cmd.set_defaults(run=collect)

    review_cmd = commands.add_parser("review", help="turn collected JSONL into a label CSV")
    review_cmd.add_argument("--input", required=True)
    review_cmd.add_argument("--output", required=True, help="new CSV file, or - for stdout")
    review_cmd.set_defaults(run=review)

    report_cmd = commands.add_parser("report", help="summarize a labelled review CSV")
    report_cmd.add_argument("--input", required=True)
    report_cmd.set_defaults(run=report)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        return args.run(args)
    except (OSError, RuntimeError, sqlite3.Error, ValueError, json.JSONDecodeError) as error:
        print(f"recall evaluation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
