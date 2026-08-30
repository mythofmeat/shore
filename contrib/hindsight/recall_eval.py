"""Collect and review Hindsight recall quality against real shore turns.

The collector replays archived user turns without modifying either shore's
history or the Hindsight bank. The review step produces a CSV for lightweight
human labels; the report compares query variants and top-3/top-6 cutoffs.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
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
VARIANTS = {"user", "assistant_tail", "recent"}

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
                }
            )
        if role in {"user", "assistant"}:
            previous_role = role
            previous_text = text
    return turns


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
    turns = archived_turns(args.history, args.character, args.since)
    turns = turns[-args.limit :]
    if not turns:
        print("no archived user turns matched", file=sys.stderr)
        return 1

    output, close = output_stream(args.output)
    try:
        for index, turn in enumerate(turns, 1):
            variants = query_variants(turn, args.assistant_chars)
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
    return "\n".join(lines)


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
        help="comma-separated: user, assistant_tail, recent",
    )
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
