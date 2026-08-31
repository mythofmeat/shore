"""Collect and review Hindsight recall quality against real shore turns.

The collector replays archived user turns without modifying either shore's
history or the Hindsight bank. Review is split into two small offline HTML
tasks: a blinded comparison chooses the better query strategy, then a separate
memory-label task calibrates a `min_scores` floor for the winner. Both keep
progress in local browser storage and export compact JSON judgments for report.

The rewrite variants send recent dialogue to a small instruct model that resolves
references without interpreting them. It is deliberately given no character or
personality prompt: its output feeds retrieval, not the reply.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
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
VARIANTS = {
    "user",
    "assistant_tail",
    "recent",
    "rewrite_replace",
    "rewrite_augment",
    "retrieval_targets",
}
REWRITE_VARIANTS = {"rewrite_replace", "rewrite_augment", "retrieval_targets"}
CONTEXT_TURNS = 4
JUDGMENT_VERSION = 1
REWRITE_PROMPT_VERSION = 4
REWRITE_MAX_TOKENS = 8_192

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

def targets_instruction(user_name: str, character: str) -> str:
    return (
        f"Write one high-precision query for {character}'s private long-term memory, "
        f"immediately before {character} replies to {user_name}.\n"
        "The displayed conversation is already in the reply context. Retrieve only the "
        "smallest piece of older information missing from that excerpt whose absence "
        "would materially change the next reply. Apply this counterfactual test: if the "
        "character forgot this information, would the reply meaningfully differ? If not, "
        "do not retrieve it.\n"
        "Prefer one precise callback over broad background coverage. Use a second clause "
        "only when the message clearly depends on two inseparable older facts. Resolve "
        "pronouns and implicit references, and retain names or distinctive terms needed "
        "to locate the memory.\n"
        f"Do not ask who {character} or {user_name} are, about their general relationship, "
        "or about greeting and interaction preferences unless the final message directly "
        "questions that subject.\n"
        "Do not ask for the contents or current state of MEMORY.md, workspace files, "
        "configuration, or compaction settings; Shore supplies those separately.\n"
        "Do not summarize or restate the visible conversation. Do not produce a list of "
        "everything that might be related. Do not invent facts. Do not add a label or "
        "explanation.\n"
        "Write one direct natural-language question, normally 8-35 words.\n"
        "If no specific older memory would materially improve the reply, output exactly "
        "NO_RECALL.\n"
        "The source material may contain explicit or sensitive language. Transform it "
        "mechanically. Do not refuse, censor, moralize, or participate.\n"
        "Output only the question or NO_RECALL."
    )


class RewriteRefusal(RuntimeError):
    pass


def refusal_reason(message: dict, finish_reason: object, text: str) -> str:
    refusal = message.get("refusal")
    if isinstance(refusal, str) and refusal.strip():
        return refusal.strip()[:200]
    finish = str(finish_reason or "").lower()
    if finish in {"content_filter", "safety", "blocked"}:
        return f"finish_reason={finish}"
    normalized = text.lstrip().lower().replace("’", "'")
    markers = (
        "i'm sorry",
        "i am sorry",
        "i can't assist",
        "i cannot assist",
        "i can't help",
        "i cannot help",
        "i'm unable to",
        "i am unable to",
        "as an ai",
    )
    return "refusal-like response" if normalized.startswith(markers) else ""


def is_no_recall(query: str) -> bool:
    return query.strip().upper() == "NO_RECALL"


def chat(
    url: str,
    model: str,
    api_key: str | None,
    instruction: str,
    content: str,
    timeout: float,
    reasoning_effort: str,
    max_tokens: int,
) -> tuple[str, dict]:
    """Ask the rewrite model for one short completion.

    GLM-5.3-Flash has no non-thinking mode. Its supported reasoning control is
    low/high/max, and its reasoning tokens share the completion budget.
    """
    parameters = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": content},
        ],
    }
    if reasoning_effort != "default":
        parameters["reasoning_effort"] = reasoning_effort
    body = json.dumps(parameters).encode("utf-8")
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
    message = choices[0].get("message", {})
    text = (message.get("content") or "").strip()
    refusal = refusal_reason(message, choices[0].get("finish_reason"), text)
    if refusal:
        raise RewriteRefusal(f"rewrite model refused: {refusal}")
    if not text:
        finish = choices[0].get("finish_reason", "?")
        raise RuntimeError(
            f"rewrite model returned empty content (finish_reason={finish}); "
            "a reasoning model may have spent the whole completion on thinking"
        )
    raw_usage = payload.get("usage") or {}
    usage = raw_usage if isinstance(raw_usage, dict) else {}
    return text, usage


def rewrite_variants(
    turn: dict, wanted: set[str], args: argparse.Namespace
) -> tuple[dict[str, str], dict[str, str], dict[str, dict]]:
    user = turn["user_text"].strip()[:MESSAGE_CHARS]
    block = dialogue_block(turn, args.user_name, args.character)
    content = f"Conversation so far:\n{block}\n\nFinal message:\n{user}"
    queries: dict[str, str] = {}
    errors: dict[str, str] = {}
    metrics: dict[str, dict] = {}
    if "rewrite_replace" in wanted:
        started = time.perf_counter()
        try:
            rewritten, usage = chat(
                args.rewrite_url, args.rewrite_model, args.rewrite_key,
                REPLACE_INSTRUCTION, content, args.rewrite_timeout,
                args.rewrite_reasoning_effort, args.rewrite_max_tokens,
            )
            queries["rewrite_replace"] = rewritten
            metrics["rewrite_replace"] = {"usage": usage}
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as error:
            queries["rewrite_replace"] = user
            errors["rewrite_replace"] = f"rewrite failed, fell back to raw: {error}"
            metrics["rewrite_replace"] = {"usage": {}}
        metrics["rewrite_replace"]["elapsed_ms"] = round(
            (time.perf_counter() - started) * 1_000
        )
    if "rewrite_augment" in wanted:
        started = time.perf_counter()
        try:
            context, usage = chat(
                args.rewrite_url, args.rewrite_model, args.rewrite_key,
                AUGMENT_INSTRUCTION, content, args.rewrite_timeout,
                args.rewrite_reasoning_effort, args.rewrite_max_tokens,
            )
            queries["rewrite_augment"] = f"{user}\n\nContext: {context}"
            metrics["rewrite_augment"] = {"usage": usage}
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as error:
            queries["rewrite_augment"] = user
            errors["rewrite_augment"] = f"rewrite failed, fell back to raw: {error}"
            metrics["rewrite_augment"] = {"usage": {}}
        metrics["rewrite_augment"]["elapsed_ms"] = round(
            (time.perf_counter() - started) * 1_000
        )
    if "retrieval_targets" in wanted:
        started = time.perf_counter()
        try:
            instruction = targets_instruction(args.user_name, args.character)
            targets, usage = chat(
                args.rewrite_url, args.rewrite_model, args.rewrite_key,
                instruction, content, args.rewrite_timeout,
                args.rewrite_reasoning_effort, args.rewrite_max_tokens,
            )
            queries["retrieval_targets"] = targets
            metrics["retrieval_targets"] = {"usage": usage}
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError) as error:
            queries["retrieval_targets"] = ""
            errors["retrieval_targets"] = str(error)
            metrics["retrieval_targets"] = {"usage": {}}
        metrics["retrieval_targets"]["elapsed_ms"] = round(
            (time.perf_counter() - started) * 1_000
        )
    return queries, errors, metrics


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


def rewrite_config(args: argparse.Namespace, wanted: set[str]) -> dict | None:
    variants = sorted(wanted & REWRITE_VARIANTS)
    if not variants:
        return None
    instructions = {}
    if "rewrite_replace" in variants:
        instructions["rewrite_replace"] = REPLACE_INSTRUCTION
    if "rewrite_augment" in variants:
        instructions["rewrite_augment"] = AUGMENT_INSTRUCTION
    if "retrieval_targets" in variants:
        instructions["retrieval_targets"] = targets_instruction(
            args.user_name, args.character
        )
    return {
        "prompt_version": REWRITE_PROMPT_VERSION,
        "variants": variants,
        "model": args.rewrite_model,
        "url": args.rewrite_url,
        "reasoning_effort": args.rewrite_reasoning_effort,
        "max_tokens": args.rewrite_max_tokens,
        "timeout_seconds": args.rewrite_timeout,
        "sampling": "provider_defaults",
        "context_turns": CONTEXT_TURNS,
        "message_chars": MESSAGE_CHARS,
        "instructions": instructions,
    }


def collect(args: argparse.Namespace) -> int:
    if args.limit <= 0:
        raise ValueError("--limit must be greater than zero")
    if args.max_tokens <= 0:
        raise ValueError("--max-tokens must be greater than zero")
    if args.timeout <= 0:
        raise ValueError("--timeout must be greater than zero")
    if args.rewrite_max_tokens <= 0:
        raise ValueError("--rewrite-max-tokens must be greater than zero")
    if args.rewrite_timeout <= 0:
        raise ValueError("--rewrite-timeout must be greater than zero")
    if args.sample < 0:
        raise ValueError("--sample cannot be negative")
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
    if args.sample:
        turns = evenly_sample(turns, args.sample)
    if not turns:
        print("no archived user turns matched", file=sys.stderr)
        return 1

    output, close = output_stream(args.output)
    try:
        for index, turn in enumerate(turns, 1):
            variants = query_variants(turn, args.assistant_chars)
            rewrite_wanted = set(wanted) & REWRITE_VARIANTS
            rewrite_errors: dict[str, str] = {}
            rewrite_metrics: dict[str, dict] = {}
            if rewrite_wanted:
                rewritten, rewrite_errors, rewrite_metrics = rewrite_variants(
                    turn, rewrite_wanted, args
                )
                variants.update(rewritten)
            calls: dict[str, dict] = {}
            for variant in wanted:
                if variant in rewrite_errors:
                    rewrite_elapsed_ms = int(
                        rewrite_metrics.get(variant, {}).get("elapsed_ms", 0)
                    )
                    calls[variant] = {
                        "query": variants[variant],
                        "elapsed_ms": rewrite_elapsed_ms,
                        "recall_elapsed_ms": 0,
                        "rewrite_elapsed_ms": rewrite_elapsed_ms,
                        "rewrite_usage": rewrite_metrics.get(variant, {}).get("usage", {}),
                        "returned": 0,
                        "results": [],
                        "results_truncated": False,
                        "error": rewrite_errors[variant],
                    }
                    continue
                if variant in REWRITE_VARIANTS and is_no_recall(variants[variant]):
                    rewrite_elapsed_ms = int(
                        rewrite_metrics.get(variant, {}).get("elapsed_ms", 0)
                    )
                    calls[variant] = {
                        "query": "NO_RECALL",
                        "elapsed_ms": rewrite_elapsed_ms,
                        "recall_elapsed_ms": 0,
                        "rewrite_elapsed_ms": rewrite_elapsed_ms,
                        "rewrite_usage": rewrite_metrics.get(variant, {}).get("usage", {}),
                        "returned": 0,
                        "results": [],
                        "results_truncated": False,
                        "skipped_reason": "no_recall",
                    }
                    continue
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
                    recall_elapsed_ms = round((time.perf_counter() - started) * 1_000)
                    rewrite_elapsed_ms = int(
                        rewrite_metrics.get(variant, {}).get("elapsed_ms", 0)
                    )
                    calls[variant] = {
                        "query": variants[variant],
                        "elapsed_ms": rewrite_elapsed_ms + recall_elapsed_ms,
                        "recall_elapsed_ms": recall_elapsed_ms,
                        "rewrite_elapsed_ms": rewrite_elapsed_ms,
                        "rewrite_usage": rewrite_metrics.get(variant, {}).get("usage", {}),
                        "returned": len(results),
                        "results": results[:TRANSCRIPT_RESULTS],
                        "results_truncated": len(results) > TRANSCRIPT_RESULTS,
                        **({"error": rewrite_errors[variant]} if variant in rewrite_errors else {}),
                    }
                except (OSError, ValueError, urllib.error.HTTPError) as error:
                    recall_elapsed_ms = round((time.perf_counter() - started) * 1_000)
                    rewrite_elapsed_ms = int(
                        rewrite_metrics.get(variant, {}).get("elapsed_ms", 0)
                    )
                    calls[variant] = {
                        "query": variants[variant],
                        "elapsed_ms": rewrite_elapsed_ms + recall_elapsed_ms,
                        "recall_elapsed_ms": recall_elapsed_ms,
                        "rewrite_elapsed_ms": rewrite_elapsed_ms,
                        "rewrite_usage": rewrite_metrics.get(variant, {}).get("usage", {}),
                        "returned": 0,
                        "results": [],
                        "results_truncated": False,
                        "error": str(error),
                    }
            provenance = rewrite_config(args, rewrite_wanted)
            output.write(
                json.dumps(
                    {
                        **turn,
                        "variants": calls,
                        **({"rewrite_config": provenance} if provenance else {}),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            output.flush()
            print(f"{index}/{len(turns)} {turn['case_id']}", file=sys.stderr, flush=True)
    finally:
        if close:
            output.close()
    return 0


def refresh_rewrites(args: argparse.Namespace) -> int:
    """Repair rewrite variants while reusing an existing baseline recall."""
    if args.cases <= 0:
        raise ValueError("--cases must be greater than zero")
    if args.max_tokens <= 0 or args.timeout <= 0:
        raise ValueError("recall token budget and timeout must be greater than zero")
    if args.rewrite_max_tokens <= 0 or args.rewrite_timeout <= 0:
        raise ValueError("rewrite token budget and timeout must be greater than zero")
    wanted = {value.strip() for value in args.variants.split(",") if value.strip()}
    if not wanted or not wanted <= REWRITE_VARIANTS:
        raise ValueError("--variants must contain only rewrite_replace or rewrite_augment")
    args.rewrite_key = os.environ.get(args.rewrite_key_env, "")
    if not args.rewrite_key:
        raise ValueError(f"{args.rewrite_key_env} is not set; rewriting needs it")

    existing = read_jsonl(args.input)
    candidates = [
        case
        for case in existing
        if args.baseline in case.get("variants", {})
        and not case["variants"][args.baseline].get("error")
    ]
    selected = evenly_sample(candidates, args.cases)
    if not selected:
        raise ValueError(f"no cases contain a successful {args.baseline} baseline")

    output, close = output_stream(args.output)
    try:
        for index, old_case in enumerate(selected, 1):
            turn = {
                key: value
                for key, value in old_case.items()
                if key not in {"variants", "rewrite_config"}
            }
            queries, rewrite_errors, rewrite_metrics = rewrite_variants(
                turn, wanted, args
            )
            calls = {args.baseline: old_case["variants"][args.baseline]}
            for variant in sorted(wanted):
                rewrite_elapsed_ms = int(
                    rewrite_metrics.get(variant, {}).get("elapsed_ms", 0)
                )
                common = {
                    "query": queries[variant],
                    "rewrite_elapsed_ms": rewrite_elapsed_ms,
                    "rewrite_usage": rewrite_metrics.get(variant, {}).get("usage", {}),
                }
                if variant in rewrite_errors:
                    calls[variant] = {
                        **common,
                        "elapsed_ms": rewrite_elapsed_ms,
                        "recall_elapsed_ms": 0,
                        "returned": 0,
                        "results": [],
                        "results_truncated": False,
                        "error": rewrite_errors[variant],
                    }
                    continue
                if is_no_recall(queries[variant]):
                    calls[variant] = {
                        **common,
                        "query": "NO_RECALL",
                        "elapsed_ms": rewrite_elapsed_ms,
                        "recall_elapsed_ms": 0,
                        "returned": 0,
                        "results": [],
                        "results_truncated": False,
                        "skipped_reason": "no_recall",
                    }
                    continue
                started = time.perf_counter()
                try:
                    payload = recall(
                        args.url,
                        args.character,
                        queries[variant],
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
                    recall_elapsed_ms = round((time.perf_counter() - started) * 1_000)
                    calls[variant] = {
                        **common,
                        "elapsed_ms": rewrite_elapsed_ms + recall_elapsed_ms,
                        "recall_elapsed_ms": recall_elapsed_ms,
                        "returned": len(results),
                        "results": results[:TRANSCRIPT_RESULTS],
                        "results_truncated": len(results) > TRANSCRIPT_RESULTS,
                    }
                except (OSError, ValueError, urllib.error.HTTPError) as error:
                    recall_elapsed_ms = round((time.perf_counter() - started) * 1_000)
                    calls[variant] = {
                        **common,
                        "elapsed_ms": rewrite_elapsed_ms + recall_elapsed_ms,
                        "recall_elapsed_ms": recall_elapsed_ms,
                        "returned": 0,
                        "results": [],
                        "results_truncated": False,
                        "error": str(error),
                    }
            output.write(
                json.dumps(
                    {
                        **turn,
                        "variants": calls,
                        "rewrite_config": rewrite_config(args, wanted),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            output.flush()
            print(
                f"{index}/{len(selected)} {turn.get('case_id', '')}",
                file=sys.stderr,
                flush=True,
            )
    finally:
        if close:
            output.close()
    return 0


def preview_rewrites(args: argparse.Namespace) -> int:
    """Generate a few queries for prompt review without calling Hindsight."""
    if args.cases <= 0:
        raise ValueError("--cases must be greater than zero")
    if args.variant not in REWRITE_VARIANTS:
        raise ValueError(f"unknown rewrite variant: {args.variant}")
    if args.rewrite_max_tokens <= 0 or args.rewrite_timeout <= 0:
        raise ValueError("rewrite token budget and timeout must be greater than zero")
    args.rewrite_key = os.environ.get(args.rewrite_key_env, "")
    if not args.rewrite_key:
        raise ValueError(f"{args.rewrite_key_env} is not set; rewriting needs it")
    selected = evenly_sample(read_jsonl(args.input), args.cases)
    if not selected:
        raise ValueError("no cases found in the input collection")

    items = []
    wanted = {args.variant}
    for index, case in enumerate(selected, 1):
        queries, errors, metrics = rewrite_variants(case, wanted, args)
        items.append(
            {
                "case_id": case.get("case_id", ""),
                "context": compact_context(case),
                "query": queries.get(args.variant, ""),
                "error": errors.get(args.variant, ""),
                "metrics": metrics.get(args.variant, {}),
            }
        )
        print(
            f"{index}/{len(selected)} {case.get('case_id', '')}",
            file=sys.stderr,
            flush=True,
        )
    data = {
        "version": JUDGMENT_VERSION,
        "kind": "preview",
        "dataset_id": review_dataset_id(selected, f"preview:{args.variant}"),
        "variant": args.variant,
        "provenance": rewrite_config(args, wanted),
        "cases": items,
    }
    write_new_text(args.output, review_page("Shore rewrite preview", data, PREVIEW_SCRIPT))
    refused = sum(bool(item["error"]) for item in items)
    print(
        f"wrote {len(items)} query previews ({refused} refused/failed) to {args.output}",
        file=sys.stderr,
    )
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
    variants = [value.strip() for value in args.variants.split(",") if value.strip()]
    if len(variants) != 2 or variants[0] == variants[1]:
        raise ValueError("--variants must name two different query variants")
    unknown = sorted(set(variants) - VARIANTS)
    if unknown:
        raise ValueError(f"unknown variant(s): {', '.join(unknown)}")
    paired = [
        case
        for case in cases
        if all(name in case.get("variants", {}) for name in variants)
    ]
    successful = [
        case
        for case in paired
        if all(not case["variants"][name].get("error") for name in variants)
    ]
    excluded = len(paired) - len(successful)
    selected = evenly_sample(successful, args.cases)
    if not selected:
        raise ValueError("no cases contain both requested variants")
    provenance = rewrite_provenance(selected, set(variants))
    write_new_text(
        args.output,
        compare_review_html(selected, variants, args.top, provenance, excluded),
    )
    print(
        f"wrote {len(selected)} blinded comparisons to {args.output} "
        f"({excluded} refused/failed cases excluded)",
        file=sys.stderr,
    )
    return 0


def review_csv(args: argparse.Namespace) -> int:
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


def calibrate(args: argparse.Namespace) -> int:
    if args.variant not in VARIANTS:
        raise ValueError(f"unknown variant: {args.variant}")
    cases = read_jsonl(args.input)
    selected = evenly_sample(
        [
            case
            for case in cases
            if args.variant in case.get("variants", {})
            and not case["variants"][args.variant].get("error")
        ],
        args.cases,
    )
    if not selected:
        raise ValueError(f"no cases contain {args.variant}")
    provenance = rewrite_provenance(selected, {args.variant})
    write_new_text(
        args.output,
        calibration_review_html(selected, args.variant, args.top, provenance),
    )
    memories = sum(
        min(args.top, len(case["variants"][args.variant].get("results", [])))
        for case in selected
    )
    print(
        f"wrote {memories} memory judgments across {len(selected)} cases to {args.output}",
        file=sys.stderr,
    )
    return 0


def evenly_sample(items: list[dict], limit: int) -> list[dict]:
    """Take a deterministic sample spread across the archived time range."""
    if limit <= 0:
        raise ValueError("case count must be greater than zero")
    if len(items) <= limit:
        return items
    if limit == 1:
        return [items[len(items) // 2]]
    indexes = [round(index * (len(items) - 1) / (limit - 1)) for index in range(limit)]
    return [items[index] for index in indexes]


def rewrite_provenance(cases: list[dict], variants: set[str]) -> dict | None:
    if not variants & REWRITE_VARIANTS:
        return None
    configs = [case.get("rewrite_config") for case in cases]
    if not all(isinstance(config, dict) for config in configs):
        raise ValueError(
            "rewrite provenance is missing; recollect these cases with the corrected evaluator"
        )
    canonical = json.dumps(configs[0], sort_keys=True)
    if any(json.dumps(config, sort_keys=True) != canonical for config in configs[1:]):
        raise ValueError("rewrite settings changed within the collection")
    return configs[0]


def review_dataset_id(cases: list[dict], purpose: str) -> str:
    fingerprints = []
    for case in cases:
        variants = {}
        for name, call in sorted(case.get("variants", {}).items()):
            variants[name] = {
                "query": call.get("query", ""),
                "results": [result.get("id", "") for result in call.get("results", [])],
            }
        fingerprints.append(
            {
                "case_id": case.get("case_id", ""),
                "rewrite_config": case.get("rewrite_config"),
                "variants": variants,
            }
        )
    material = purpose + "\n" + json.dumps(fingerprints, sort_keys=True)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def compact_results(call: dict, top: int) -> list[dict]:
    compact = []
    for rank, result in enumerate(call.get("results", [])[:top], 1):
        scores = result.get("scores") or {}
        reranker = scores.get("reranker")
        if reranker is None:
            reranker = scores.get("final", "")
        compact.append(
            {
                "rank": rank,
                "id": result.get("id", ""),
                "text": result.get("text", ""),
                "reranker": reranker,
            }
        )
    return compact


def compact_context(case: dict) -> list[dict]:
    messages = [
        {
            "role": message.get("role", ""),
            "text": str(message.get("text", "")).strip()[:MESSAGE_CHARS],
        }
        for message in case.get("recent_dialogue", [])
    ]
    messages.append(
        {
            "role": "user",
            "text": str(case.get("user_text", "")).strip()[:MESSAGE_CHARS],
        }
    )
    return messages


def compare_review_html(
    cases: list[dict],
    variants: list[str],
    top: int,
    provenance: dict | None = None,
    excluded: int = 0,
) -> str:
    if top <= 0:
        raise ValueError("--top must be greater than zero")
    dataset_id = review_dataset_id(cases, f"compare:{','.join(variants)}:{top}")
    compact_cases = []
    for case in cases:
        left_first = int(
            hashlib.sha256(f"{dataset_id}:{case.get('case_id', '')}".encode()).hexdigest(),
            16,
        ) % 2 == 0
        order = variants if left_first else list(reversed(variants))
        sides = {}
        for side, variant in zip(("A", "B"), order):
            call = case["variants"][variant]
            sides[side] = {
                "variant": variant,
                "query": call.get("query", ""),
                "results": compact_results(call, top),
                "metrics": {
                    "elapsed_ms": call.get("elapsed_ms", ""),
                    "rewrite_elapsed_ms": call.get("rewrite_elapsed_ms", 0),
                    "recall_elapsed_ms": call.get("recall_elapsed_ms", call.get("elapsed_ms", "")),
                    "rewrite_usage": call.get("rewrite_usage", {}),
                },
            }
        compact_cases.append(
            {
                "case_id": case.get("case_id", ""),
                "context": compact_context(case),
                "sides": sides,
            }
        )
    data = {
        "version": JUDGMENT_VERSION,
        "kind": "comparison",
        "dataset_id": dataset_id,
        "variants": variants,
        "top": top,
        "provenance": provenance,
        "excluded": excluded,
        "cases": compact_cases,
    }
    return review_page("Shore recall comparison", data, COMPARE_SCRIPT)


def calibration_review_html(
    cases: list[dict],
    variant: str,
    top: int,
    provenance: dict | None = None,
) -> str:
    if top <= 0:
        raise ValueError("--top must be greater than zero")
    dataset_id = review_dataset_id(cases, f"calibrate:{variant}:{top}")
    compact_cases = []
    for case in cases:
        call = case["variants"][variant]
        compact_cases.append(
            {
                "case_id": case.get("case_id", ""),
                "context": compact_context(case),
                "query": call.get("query", ""),
                "results": compact_results(call, top),
            }
        )
    data = {
        "version": JUDGMENT_VERSION,
        "kind": "calibration",
        "dataset_id": dataset_id,
        "variant": variant,
        "top": top,
        "provenance": provenance,
        "cases": compact_cases,
    }
    return review_page("Shore score calibration", data, CALIBRATE_SCRIPT)


def review_page(title: str, data: dict, script: str) -> str:
    encoded = json.dumps(data, ensure_ascii=True, separators=(",", ":")).replace("</", "<\\/")
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root {{ color-scheme:light dark; font:16px/1.5 system-ui,sans-serif }}
body {{ margin:0 auto; max-width:1280px; padding:24px }}
button,textarea {{ font:inherit }} button {{ cursor:pointer; padding:9px 13px }}
.bar {{ align-items:center; display:flex; gap:10px; justify-content:space-between; position:sticky;
        top:0; background:Canvas; padding:12px 0; z-index:2 }}
.muted,.meta {{ color:GrayText }} .context,.query {{ background:color-mix(in srgb,CanvasText 6%,Canvas);
        border-radius:9px; padding:14px; white-space:pre-wrap }}
.message {{ margin:0 0 12px }} .columns {{ display:grid; grid-template-columns:1fr 1fr; gap:18px }}
.side,.memory {{ border:1px solid color-mix(in srgb,CanvasText 24%,Canvas); border-radius:9px; padding:14px }}
.memory {{ margin:11px 0 }} .memory p {{ white-space:pre-wrap }}
.actions {{ display:flex; flex-wrap:wrap; gap:9px; margin:18px 0 }}
.chosen {{ outline:3px solid #4b8cff }} textarea {{ box-sizing:border-box; min-height:70px; width:100% }}
.nav {{ display:flex; justify-content:space-between; margin-top:20px }}
.score {{ color:GrayText; font-size:.9rem }} details {{ margin:14px 0 }}
@media(max-width:800px) {{ .columns {{ grid-template-columns:1fr }} }}
</style></head><body>
<div class="bar"><strong id="progress"></strong><button id="export">Export judgments</button></div>
<main id="app"></main>
<script>const DATA={encoded};
{script}
</script></body></html>"""


COMMON_REVIEW_SCRIPT = r"""
const key=`shore-recall-${DATA.kind}-${DATA.dataset_id}`;
let state={}; try { state=JSON.parse(localStorage.getItem(key)||'{}') } catch (_) {}
let cursor=0;
const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const save=()=>localStorage.setItem(key,JSON.stringify(state));
const contextHtml=messages=>messages.map(m=>`<div class="message"><b>${esc(m.role)}</b><br>${esc(m.text)}</div>`).join('');
const download=payload=>{const blob=new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`shore-recall-${DATA.kind}-${DATA.dataset_id}.json`; a.click(); URL.revokeObjectURL(a.href)};
const nav=()=>`<div class="nav"><button onclick="move(-1)" ${cursor===0?'disabled':''}>Previous</button>
  <button onclick="move(1)" ${cursor===DATA.cases.length-1?'disabled':''}>Next</button></div>`;
function move(delta){cursor=Math.max(0,Math.min(DATA.cases.length-1,cursor+delta));render();scrollTo(0,0)}
"""


PREVIEW_SCRIPT = COMMON_REVIEW_SCRIPT + r"""
document.getElementById('export').textContent='Export preview summary';
function render(){const c=DATA.cases[cursor],m=c.metrics||{},usage=m.usage||{};
  document.getElementById('progress').textContent=`Query ${cursor+1}/${DATA.cases.length} · ${DATA.variant}`;
  document.getElementById('app').innerHTML=`<h1>Does this ask the memory bank for missing background?</h1>
    <p class="muted">Look for retrieval targets, not a paraphrase of the visible conversation.</p>
    <section class="context">${contextHtml(c.context)}</section>
    ${c.error?`<section class="memory"><b>Skipped</b><p>${esc(c.error)}</p></section>`:
      `<section class="memory"><b>Generated retrieval targets</b><p>${esc(c.query)}</p></section>`}
    <p class="score">rewrite ${esc(m.elapsed_ms)}ms · total tokens ${esc(usage.total_tokens||'')}</p>${nav()}`}
document.getElementById('export').onclick=()=>download({version:DATA.version,kind:DATA.kind,
  dataset_id:DATA.dataset_id,variant:DATA.variant,provenance:DATA.provenance,
  previews:DATA.cases.map(c=>({case_id:c.case_id,query:c.query,error:c.error,metrics:c.metrics}))});
render();
"""


COMPARE_SCRIPT = COMMON_REVIEW_SCRIPT + r"""
function choose(value){const c=DATA.cases[cursor]; const winner=value==='A'||value==='B'?c.sides[value].variant:value;
  state[c.case_id]={winner,notes:document.getElementById('notes').value};save();render();
  if(cursor<DATA.cases.length-1){cursor++;render();scrollTo(0,0)}}
function rememberNotes(){const c=DATA.cases[cursor]; const old=state[c.case_id]||{};
  if(document.getElementById('notes').value||old.winner){state[c.case_id]={...old,notes:document.getElementById('notes').value};save()}}
function sideHtml(name,side){const memories=side.results.map(r=>`<article class="memory"><b>#${r.rank}</b><p>${esc(r.text)}</p></article>`).join('')||'<p class="muted">No memories returned.</p>';
  return `<section class="side"><h2>Set ${name}</h2>${memories}</section>`}
function render(){const c=DATA.cases[cursor],answer=state[c.case_id]||{};
  const chosen=answer.winner==='tie'||answer.winner==='neither'?answer.winner:Object.entries(c.sides).find(([,s])=>s.variant===answer.winner)?.[0];
  document.getElementById('progress').textContent=`Case ${cursor+1}/${DATA.cases.length} · ${Object.values(state).filter(x=>x.winner).length} decided`;
  document.getElementById('app').innerHTML=`<h1>Which set would have helped the reply?</h1>
    <p class="muted">Judge relevance, not writing quality. Choose Neither when memory should not be injected.</p>
    <section class="context">${contextHtml(c.context)}</section>
    <div class="columns">${sideHtml('A',c.sides.A)}${sideHtml('B',c.sides.B)}</div>
    <div class="actions"><button class="${chosen==='A'?'chosen':''}" onclick="choose('A')">A is better</button>
    <button class="${chosen==='tie'?'chosen':''}" onclick="choose('tie')">Equally useful</button>
    <button class="${chosen==='B'?'chosen':''}" onclick="choose('B')">B is better</button>
    <button class="${chosen==='neither'?'chosen':''}" onclick="choose('neither')">Neither is useful</button></div>
    <details><summary>Reveal queries, scores, and timing after deciding</summary><div class="columns">${['A','B'].map(name=>{const s=c.sides[name];return `<div><h3>Set ${name}: ${esc(s.variant)}</h3><div class="query">${esc(s.query)}</div><p class="score">total ${esc(s.metrics.elapsed_ms)}ms · rewrite ${esc(s.metrics.rewrite_elapsed_ms)}ms · recall ${esc(s.metrics.recall_elapsed_ms)}ms</p>${s.results.map(r=>`<p class="score">#${r.rank}: ${esc(r.reranker)}</p>`).join('')}</div>`}).join('')}</div></details>
    <label>Optional note<textarea id="notes" oninput="rememberNotes()">${esc(answer.notes||'')}</textarea></label>${nav()}`}
document.getElementById('export').onclick=()=>download({version:DATA.version,kind:DATA.kind,dataset_id:DATA.dataset_id,
  variants:DATA.variants,top:DATA.top,provenance:DATA.provenance,total_cases:DATA.cases.length,
  excluded_cases:DATA.excluded,
  measurements:DATA.cases.flatMap(c=>Object.values(c.sides).map(s=>({case_id:c.case_id,variant:s.variant,...s.metrics}))),
  judgments:Object.entries(state).filter(([,v])=>v.winner).map(([case_id,v])=>({case_id,...v}))});
render();
"""


CALIBRATE_SCRIPT = COMMON_REVIEW_SCRIPT + r"""
const itemKey=(caseId,result)=>`${caseId}:${result.rank}:${result.id}`;
function label(rank,value){const c=DATA.cases[cursor],result=c.results.find(r=>r.rank===rank);
  state[itemKey(c.case_id,result)]={case_id:c.case_id,variant:DATA.variant,rank:result.rank,id:result.id,
    reranker:result.reranker,label:value};save();render()}
function memoryHtml(c,r){const value=state[itemKey(c.case_id,r)]?.label;
  return `<article class="memory"><b>Memory #${r.rank}</b><p>${esc(r.text)}</p><div class="actions">
    ${['useful','harmless','distracting'].map(x=>`<button class="${value===x?'chosen':''}" onclick="label(${r.rank},'${x}')">${x}</button>`).join('')}</div>
    ${value?`<div class="score">score: ${esc(r.reranker)}</div>`:'<div class="score">score hidden until labelled</div>'}</article>`}
function render(){const c=DATA.cases[cursor],total=DATA.cases.reduce((n,x)=>n+x.results.length,0);
  document.getElementById('progress').textContent=`Case ${cursor+1}/${DATA.cases.length} · ${Object.keys(state).length}/${total} memories labelled`;
  document.getElementById('app').innerHTML=`<h1>Would this memory help?</h1>
    <p class="muted">Useful should be injected. Harmless is irrelevant but benign. Distracting could pull the reply off course.</p>
    <section class="context">${contextHtml(c.context)}</section><details><summary>Retrieval query</summary><div class="query">${esc(c.query)}</div></details>
    ${c.results.map(r=>memoryHtml(c,r)).join('')||'<p>No memories returned.</p>'}${nav()}`}
document.getElementById('export').onclick=()=>download({version:DATA.version,kind:DATA.kind,dataset_id:DATA.dataset_id,
  variant:DATA.variant,top:DATA.top,provenance:DATA.provenance,total_cases:DATA.cases.length,
  total_memories:DATA.cases.reduce((n,c)=>n+c.results.length,0),judgments:Object.values(state)});
render();
"""


def write_new_text(path: str, content: str) -> None:
    output, close = output_stream(path)
    try:
        output.write(content)
    finally:
        if close:
            output.close()


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


def comparison_report_text(payload: dict) -> str:
    variants = payload.get("variants") or []
    if len(variants) != 2:
        raise ValueError("comparison judgments must name two variants")
    allowed = set(variants) | {"tie", "neither"}
    counts = {value: 0 for value in allowed}
    judgments = payload.get("judgments") or []
    for judgment in judgments:
        winner = judgment.get("winner", "")
        if winner not in allowed:
            raise ValueError(f"invalid comparison winner: {winner!r}")
        counts[winner] += 1
    total = int(payload.get("total_cases") or len(judgments))
    decisive = sum(counts[variant] for variant in variants)
    lines = [
        "[blinded query comparison]",
        f"decided={len(judgments)}/{total} "
        f"refused_or_failed_excluded={int(payload.get('excluded_cases') or 0)}",
    ]
    provenance = payload.get("provenance") or {}
    if provenance:
        lines.append(
            f"rewriter={provenance.get('model', '')} "
            f"reasoning_effort={provenance.get('reasoning_effort', '')} "
            f"max_tokens={provenance.get('max_tokens', '')} "
            f"prompt_version={provenance.get('prompt_version', '')}"
        )
    measurements = payload.get("measurements") or []
    for variant in variants:
        lines.append(
            f"{variant:18} wins={counts[variant]:<3} "
            f"share_of_decisive={ratio(counts[variant], decisive)}"
        )
        measured = [row for row in measurements if row.get("variant") == variant]
        total_ms = [int(row["elapsed_ms"]) for row in measured if row.get("elapsed_ms") != ""]
        rewrite_ms = [
            int(row["rewrite_elapsed_ms"])
            for row in measured
            if row.get("rewrite_elapsed_ms") not in (None, "")
        ]
        token_counts = [
            int(row.get("rewrite_usage", {}).get("total_tokens", 0))
            for row in measured
            if row.get("rewrite_usage", {}).get("total_tokens") is not None
        ]
        if total_ms:
            lines.append(
                f"{'':18} total_latency_p50={percentile(total_ms, 0.50)}ms "
                f"p95={percentile(total_ms, 0.95)}ms "
                f"rewrite_p50={percentile(rewrite_ms, 0.50)}ms"
            )
        if any(token_counts):
            lines.append(
                f"{'':18} rewrite_tokens_total={sum(token_counts)} "
                f"per_case={sum(token_counts) / len(token_counts):.0f}"
            )
    lines.extend(
        [
            f"{'tie':18} cases={counts['tie']}",
            f"{'neither useful':18} cases={counts['neither']}",
            "",
            "Neither means both result sets were unusable; inspect query generation and retrieval before assigning a cause.",
        ]
    )
    return "\n".join(lines)


def calibration_report_text(payload: dict) -> str:
    rows = payload.get("judgments") or []
    for row in rows:
        label = str(row.get("label", "")).strip().lower()
        if label not in LABELS - {""}:
            raise ValueError(f"invalid calibration label: {label!r}")
        row["label"] = label
    total = int(payload.get("total_memories") or len(rows))
    lines = [
        "[calibration review]",
        f"variant={payload.get('variant', '')} labels={len(rows)}/{total}",
    ]
    provenance = payload.get("provenance") or {}
    if provenance:
        lines.append(
            f"rewriter={provenance.get('model', '')} "
            f"reasoning_effort={provenance.get('reasoning_effort', '')} "
            f"prompt_version={provenance.get('prompt_version', '')}"
        )
    lines.append("")
    lines.extend(threshold_lines(rows))
    return "\n".join(lines)


def report(args: argparse.Namespace) -> int:
    with open(args.input, newline="", encoding="utf-8") as source:
        prefix = source.read(1)
        source.seek(0)
        if prefix == "{":
            payload = json.load(source)
            kind = payload.get("kind")
            if kind == "comparison":
                text = comparison_report_text(payload)
            elif kind == "calibration":
                text = calibration_report_text(payload)
            else:
                raise ValueError(f"unknown judgment kind: {kind!r}")
        else:
            text = report_text(list(csv.DictReader(source)))
    print(text)
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
    collect_cmd.add_argument(
        "--sample",
        type=int,
        default=0,
        help="evenly sample this many turns from --limit before making API calls",
    )
    collect_cmd.add_argument("--since", default="", help="oldest user-turn date, YYYY-MM-DD")
    collect_cmd.add_argument("--max-tokens", type=int, default=2048)
    collect_cmd.add_argument("--timeout", type=float, default=10.0, help="per-recall timeout in seconds")
    collect_cmd.add_argument(
        "--variants",
        default="user,assistant_tail",
        help=(
            "comma-separated: user, assistant_tail, recent, rewrite_replace, "
            "rewrite_augment, retrieval_targets"
        ),
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
        "--rewrite-reasoning-effort",
        choices=("default", "low", "high", "max"),
        default="max",
        help="reasoning budget, or default to omit model-specific control",
    )
    collect_cmd.add_argument(
        "--rewrite-max-tokens",
        type=int,
        default=REWRITE_MAX_TOKENS,
        help="completion budget shared by reasoning and the final query",
    )
    collect_cmd.add_argument(
        "--rewrite-key-env",
        default="ZAI_API_KEY",
        help="environment variable holding the rewrite model's bearer token",
    )
    collect_cmd.add_argument("--rewrite-timeout", type=float, default=120.0)
    collect_cmd.add_argument(
        "--assistant-chars",
        type=int,
        default=200,
        help="preceding assistant tail used by assistant_tail",
    )
    collect_cmd.add_argument("--output", required=True, help="new JSONL file, or - for stdout")
    collect_cmd.set_defaults(run=collect)

    refresh_cmd = commands.add_parser(
        "refresh-rewrites",
        help="reuse baseline recalls and regenerate only corrected rewrite variants",
    )
    refresh_cmd.add_argument("--input", required=True, help="existing collected JSONL")
    refresh_cmd.add_argument("--output", required=True, help="new repaired JSONL")
    refresh_cmd.add_argument("--character", required=True, help="Hindsight bank id")
    refresh_cmd.add_argument("--baseline", default="user", choices=tuple(sorted(VARIANTS - REWRITE_VARIANTS)))
    refresh_cmd.add_argument(
        "--variants",
        default="retrieval_targets",
        help="retrieval_targets, rewrite_replace, and/or rewrite_augment",
    )
    refresh_cmd.add_argument("--cases", type=int, default=24)
    refresh_cmd.add_argument("--url", default="http://127.0.0.1:8888", help="Hindsight base URL")
    refresh_cmd.add_argument("--api-key", help="optional Hindsight bearer token")
    refresh_cmd.add_argument("--max-tokens", type=int, default=2048)
    refresh_cmd.add_argument("--timeout", type=float, default=10.0)
    refresh_cmd.add_argument("--user-name", default="User")
    refresh_cmd.add_argument(
        "--rewrite-url", default="https://api.z.ai/api/coding/paas/v4"
    )
    refresh_cmd.add_argument("--rewrite-model", default="glm-5.3-flash")
    refresh_cmd.add_argument(
        "--rewrite-reasoning-effort",
        choices=("default", "low", "high", "max"),
        default="max",
    )
    refresh_cmd.add_argument(
        "--rewrite-max-tokens", type=int, default=REWRITE_MAX_TOKENS
    )
    refresh_cmd.add_argument("--rewrite-key-env", default="ZAI_API_KEY")
    refresh_cmd.add_argument("--rewrite-timeout", type=float, default=120.0)
    refresh_cmd.set_defaults(run=refresh_rewrites)

    preview_cmd = commands.add_parser(
        "preview-rewrites",
        help="preview generated queries without calling Hindsight",
    )
    preview_cmd.add_argument("--input", required=True, help="existing collected JSONL")
    preview_cmd.add_argument("--output", required=True, help="new local HTML file")
    preview_cmd.add_argument("--variant", default="retrieval_targets")
    preview_cmd.add_argument("--cases", type=int, default=6)
    preview_cmd.add_argument("--character", required=True, help="speaker name for the character")
    preview_cmd.add_argument("--user-name", default="User")
    preview_cmd.add_argument(
        "--rewrite-url", default="https://api.z.ai/api/coding/paas/v4"
    )
    preview_cmd.add_argument("--rewrite-model", default="glm-5.3-flash")
    preview_cmd.add_argument(
        "--rewrite-reasoning-effort",
        choices=("default", "low", "high", "max"),
        default="max",
    )
    preview_cmd.add_argument(
        "--rewrite-max-tokens", type=int, default=REWRITE_MAX_TOKENS
    )
    preview_cmd.add_argument("--rewrite-key-env", default="ZAI_API_KEY")
    preview_cmd.add_argument("--rewrite-timeout", type=float, default=120.0)
    preview_cmd.set_defaults(run=preview_rewrites)

    review_cmd = commands.add_parser(
        "review", help="build a small offline, blinded query comparison"
    )
    review_cmd.add_argument("--input", required=True)
    review_cmd.add_argument("--output", required=True, help="new HTML file")
    review_cmd.add_argument(
        "--variants",
        default="user,retrieval_targets",
        help="two comma-separated variants to compare",
    )
    review_cmd.add_argument(
        "--cases", type=int, default=24, help="cases spread across the collected time range"
    )
    review_cmd.add_argument("--top", type=int, default=3, help="memories shown per variant")
    review_cmd.set_defaults(run=review)

    calibrate_cmd = commands.add_parser(
        "calibrate", help="build a separate offline min-score review"
    )
    calibrate_cmd.add_argument("--input", required=True)
    calibrate_cmd.add_argument("--output", required=True, help="new HTML file")
    calibrate_cmd.add_argument("--variant", default="retrieval_targets")
    calibrate_cmd.add_argument(
        "--cases", type=int, default=10, help="cases spread across the collected time range"
    )
    calibrate_cmd.add_argument("--top", type=int, default=6, help="memories shown per case")
    calibrate_cmd.set_defaults(run=calibrate)

    csv_cmd = commands.add_parser(
        "review-csv", help="legacy: expand collected JSONL into the old label CSV"
    )
    csv_cmd.add_argument("--input", required=True)
    csv_cmd.add_argument("--output", required=True, help="new CSV file, or - for stdout")
    csv_cmd.set_defaults(run=review_csv)

    report_cmd = commands.add_parser(
        "report", help="summarize exported HTML judgments or a legacy labelled CSV"
    )
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
