#!/usr/bin/env python3
"""Backfill per-message `model` provenance onto existing history segments.

One-time companion to the forward-only stamping added in
`feat/model-provenance` (Message.model / MessageAlternative.model). Two joins:

  1. SillyTavern era — `legacy_sillytavern_*.jsonl` segment messages map back
     to the archived ST originals by deterministic msg_id
     (`sha1(source_label\\0rel_path\\0line_no\\0role\\0text)[:24]`, the exact
     scheme of scripts/import_sillytavern_history.py). Message model comes
     from `extra.model` (fallback: selected swipe's `swipe_info[].extra.model`);
     imported alternatives get their own per-swipe models by replicating the
     import script's swipe dedup so indices align.

  2. Ledger era — assistant messages in numbered segments and `active.jsonl`
     join to `ledger.db` `calls` rows by timestamp. Empirically the persist
     timestamp lands ~10-30ms after the minting call's ledger row, so the
     nearest voice call (message / tool_loop / heartbeat / heartbeat_tool_loop)
     within a tight tolerance is the minting call. If a *different-model* call
     also sits within the ambiguity window, the message is flagged and left
     unstamped. Alternatives (regenerations) join on their own timestamps.

Stamps `model` ONLY — never `provider_key` (retroactive provider_key would
change thinking-replay portability filtering).

Dry-run by default; prints a coverage report. `--apply` rewrites files in
place (only files with at least one new stamp; unmodified lines stay
byte-identical) after copying originals to
`<character-data-dir>/backfill-backups/model-<UTC>/`.

`active.jsonl` is only touched with `--include-active`, and only while the
daemon is stopped (whole-file rewrites race a live daemon; sealed segments are
safe live). Existing `model` values are never overwritten.
"""

from __future__ import annotations

import argparse
import bisect
import datetime as dt
import glob
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from collections import Counter
from pathlib import Path

ARCHIVE_DEFAULT = (
    "~/.local/share/shore/archive/chat_history/"
    "2024-11-12--2026-02-24 - sillytavern chats"
)
LEDGER_DEFAULT = "~/.local/share/shore/ledger.db"
CHARACTER_DIR_DEFAULT = "~/.local/share/shore/poppy"

# Ledger call types that mint conversation messages (interactive voice +
# heartbeat's autonomous voice). Everything else is machinery.
VOICE_CALL_TYPES = ("message", "tool_loop", "heartbeat", "heartbeat_tool_loop")

# SillyTavern `extra.model` values that aren't models.
ST_NON_MODELS = {"slash command"}


# --- SillyTavern era -------------------------------------------------------


def st_message_id(source_label: str, rel_path: str, line_no: int, role: str, text: str) -> str:
    digest = hashlib.sha1(
        f"{source_label}\0{rel_path}\0{line_no}\0{role}\0{text}".encode("utf-8")
    ).hexdigest()[:24]
    safe_label = re.sub(r"[^a-zA-Z0-9]+", "_", source_label).strip("_").lower()
    return f"m_import_{safe_label}_{digest}"


def st_model(record: dict) -> str | None:
    extra = record.get("extra") or {}
    model = extra.get("model")
    if not model:
        swipes = record.get("swipe_info") or []
        sid = record.get("swipe_id") or 0
        if isinstance(swipes, list) and isinstance(sid, int) and 0 <= sid < len(swipes):
            info = swipes[sid]
            if isinstance(info, dict):
                model = (info.get("extra") or {}).get("model")
    if not isinstance(model, str) or not model.strip() or model in ST_NON_MODELS:
        return None
    return model


def st_alternative_models(record: dict) -> list[str | None]:
    """Per-imported-alternative models, aligned with the import script's dedup.

    Mirrors import_sillytavern_history.alternatives_from_sillytavern: iterate
    raw swipes, skip non-strings / blanks / duplicates; each surviving swipe's
    original index looks up swipe_info[index].extra.model.
    """
    raw_swipes = record.get("swipes")
    if not isinstance(raw_swipes, list):
        return []
    raw_info = record.get("swipe_info")
    swipe_info = raw_info if isinstance(raw_info, list) else []
    models: list[str | None] = []
    seen: set[str] = set()
    for index, raw_swipe in enumerate(raw_swipes):
        if not isinstance(raw_swipe, str) or not raw_swipe.strip():
            continue
        if raw_swipe in seen:
            continue
        seen.add(raw_swipe)
        model = None
        if index < len(swipe_info) and isinstance(swipe_info[index], dict):
            model = (swipe_info[index].get("extra") or {}).get("model")
        if not isinstance(model, str) or not model.strip() or model in ST_NON_MODELS:
            model = None
        models.append(model)
    return models


def build_st_model_map(st_dir: Path, source_label: str, stats: Counter) -> dict[str, tuple]:
    """msg_id -> (model | None, [alt models] aligned with imported alternatives)."""
    mapping: dict[str, tuple] = {}
    paths = sorted(
        p for p in st_dir.rglob("*") if p.is_file() and not p.name.startswith(".")
    )
    for path in paths:
        rel = str(path.relative_to(st_dir))
        with path.open(encoding="utf-8") as handle:
            for line_no, raw in enumerate(handle, start=1):
                line = raw.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict) or "chat_metadata" in record:
                    continue
                if not isinstance(record.get("mes"), str):
                    continue
                if record.get("is_user") or record.get("is_system") is True:
                    continue  # only assistant content carries a model
                text = record["mes"]
                if not text.strip():
                    continue
                stats["archive_assistant_msgs"] += 1
                model = st_model(record)
                alt_models = st_alternative_models(record)
                if model is None and not any(alt_models):
                    stats["archive_no_model"] += 1
                    continue
                msg_id = st_message_id(source_label, rel, line_no, "assistant", text)
                mapping[msg_id] = (model, alt_models)
    return mapping


# --- Ledger era ------------------------------------------------------------


def parse_rfc3339(raw: str) -> dt.datetime | None:
    if not raw:
        return None
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None  # ledger-era shore timestamps always carry an offset
    return parsed.astimezone(dt.timezone.utc)


class LedgerIndex:
    def __init__(self, ledger_path: Path, characters: list[str]):
        placeholders_c = ",".join("?" * len(characters))
        placeholders_t = ",".join("?" * len(VOICE_CALL_TYPES))
        uri = f"file:{ledger_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        try:
            rows = conn.execute(
                f"SELECT ts, model, call_type FROM calls "
                f"WHERE character IN ({placeholders_c}) "
                f"AND call_type IN ({placeholders_t})",
                (*characters, *VOICE_CALL_TYPES),
            ).fetchall()
        finally:
            conn.close()
        calls = []
        for ts, model, call_type in rows:
            when = parse_rfc3339(ts)
            if when is not None and model:
                calls.append((when, model, call_type))
        calls.sort(key=lambda c: c[0])
        self.calls = calls
        self.times = [c[0] for c in calls]

    def match(
        self, when: dt.datetime, tolerance: float, ambiguity: float
    ) -> tuple[str | None, bool, float | None]:
        """(model, ambiguous, offset_seconds). Nearest voice call within
        `tolerance` wins; a different-model call within `ambiguity` of the
        message flags the match instead of stamping."""
        index = bisect.bisect_left(self.times, when)
        best = None
        for j in range(max(0, index - 4), min(len(self.calls), index + 4)):
            delta = abs((self.calls[j][0] - when).total_seconds())
            if best is None or delta < best[0]:
                best = (delta, self.calls[j][1])
        if best is None or best[0] > tolerance:
            return None, False, None
        for j in range(max(0, index - 8), min(len(self.calls), index + 8)):
            delta = abs((self.calls[j][0] - when).total_seconds())
            if delta <= ambiguity and self.calls[j][1] != best[1]:
                return None, True, best[0]
        return best[1], False, best[0]


# --- Segment rewriting -----------------------------------------------------


def stamp_st_file(path: Path, model_map: dict[str, tuple], stats: Counter, notes: list[str]):
    """Returns (new_lines | None if unchanged)."""
    out_lines: list[str] = []
    changed = False
    with path.open(encoding="utf-8") as handle:
        for raw in handle:
            line = raw.rstrip("\n")
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                out_lines.append(line)
                continue
            if obj.get("role") != "assistant":
                out_lines.append(line)
                continue
            stats["st_assistant_msgs"] += 1
            entry = model_map.get(obj.get("msg_id", ""))
            if entry is None:
                stats["st_unmatched"] += 1
                out_lines.append(line)
                continue
            stats["st_matched"] += 1
            model, alt_models = entry
            modified = False
            if model is not None and not obj.get("model"):
                obj["model"] = model
                stats["st_stamped"] += 1
                modified = True
            elif model is None:
                stats["st_matched_no_model"] += 1
            alternatives = obj.get("alternatives")
            if isinstance(alternatives, list) and alternatives:
                stats["st_msgs_with_alts"] += 1
                if len(alternatives) == len(alt_models):
                    for alt, alt_model in zip(alternatives, alt_models):
                        if not isinstance(alt, dict):
                            continue
                        if alt_model is not None and not alt.get("model"):
                            alt["model"] = alt_model
                            stats["st_alt_stamped"] += 1
                            modified = True
                        elif alt_model is None:
                            stats["st_alt_no_model"] += 1
                else:
                    stats["st_alt_count_mismatch"] += 1
                    if len(notes) < 20:
                        notes.append(
                            f"alt count mismatch {path.name} {obj.get('msg_id')}: "
                            f"segment {len(alternatives)} vs archive {len(alt_models)}"
                        )
            if modified:
                changed = True
                out_lines.append(json.dumps(obj, ensure_ascii=False))
            else:
                out_lines.append(line)
    return out_lines if changed else None


def stamp_ledger_file(
    path: Path,
    ledger: LedgerIndex,
    tolerance: float,
    ambiguity: float,
    stats: Counter,
    notes: list[str],
    offsets: list[float],
):
    out_lines: list[str] = []
    changed = False
    with path.open(encoding="utf-8") as handle:
        for raw in handle:
            line = raw.rstrip("\n")
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                out_lines.append(line)
                continue
            if obj.get("role") != "assistant":
                out_lines.append(line)
                continue
            stats["ledger_assistant_msgs"] += 1
            modified = False
            if obj.get("model"):
                stats["ledger_already_stamped"] += 1
            else:
                when = parse_rfc3339(obj.get("timestamp", ""))
                if when is None:
                    stats["ledger_unparsed_ts"] += 1
                else:
                    model, ambiguous, offset = ledger.match(when, tolerance, ambiguity)
                    if model is not None:
                        obj["model"] = model
                        stats["ledger_stamped"] += 1
                        offsets.append(offset)
                        modified = True
                    elif ambiguous:
                        stats["ledger_ambiguous"] += 1
                        if len(notes) < 20:
                            notes.append(
                                f"ambiguous {path.name} {obj.get('msg_id')} "
                                f"@ {obj.get('timestamp')}"
                            )
                    else:
                        stats["ledger_unmatched"] += 1
            alternatives = obj.get("alternatives")
            if isinstance(alternatives, list):
                for alt in alternatives:
                    if not isinstance(alt, dict) or alt.get("model"):
                        continue
                    stats["ledger_alts"] += 1
                    alt_when = parse_rfc3339(alt.get("timestamp", ""))
                    if alt_when is None:
                        stats["ledger_alt_unparsed_ts"] += 1
                        continue
                    model, ambiguous, offset = ledger.match(alt_when, tolerance, ambiguity)
                    if model is not None:
                        alt["model"] = model
                        stats["ledger_alt_stamped"] += 1
                        offsets.append(offset)
                        modified = True
                    elif ambiguous:
                        stats["ledger_alt_ambiguous"] += 1
                    else:
                        stats["ledger_alt_unmatched"] += 1
            if modified:
                changed = True
                out_lines.append(json.dumps(obj, ensure_ascii=False))
            else:
                out_lines.append(line)
    return out_lines if changed else None


def daemon_running() -> bool:
    probe = subprocess.run(
        ["pgrep", "-x", "shore-daemon"], capture_output=True, check=False
    )
    return probe.returncode == 0


def write_back(path: Path, lines: list[str], backup_dir: Path):
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup_dir / path.name)
    tmp = path.with_name(path.name + ".backfill-tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(path)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--character-data-dir", default=CHARACTER_DIR_DEFAULT, type=Path)
    ap.add_argument("--st-archive", default=ARCHIVE_DEFAULT, type=Path)
    ap.add_argument("--source-label", default="sillytavern")
    ap.add_argument("--segment-prefix", default="legacy_sillytavern")
    ap.add_argument("--ledger", default=LEDGER_DEFAULT, type=Path)
    ap.add_argument("--characters", default="qifei,poppy")
    ap.add_argument("--tolerance-seconds", type=float, default=10.0)
    ap.add_argument("--ambiguity-seconds", type=float, default=5.0)
    ap.add_argument("--include-active", action="store_true",
                    help="also stamp active.jsonl (daemon must be stopped)")
    ap.add_argument("--apply", action="store_true", help="write changes (default dry-run)")
    args = ap.parse_args()

    character_dir = args.character_data_dir.expanduser().resolve()
    st_dir = args.st_archive.expanduser().resolve()
    ledger_path = args.ledger.expanduser().resolve()
    segments_dir = character_dir / "segments"
    if not segments_dir.is_dir():
        raise SystemExit(f"no segments dir: {segments_dir}")
    if not st_dir.is_dir():
        raise SystemExit(f"no ST archive dir: {st_dir}")
    if not ledger_path.is_file():
        raise SystemExit(f"no ledger: {ledger_path}")

    if args.include_active and args.apply and daemon_running():
        raise SystemExit(
            "shore-daemon is running; stop it before rewriting active.jsonl "
            "(sealed segments are safe live — rerun without --include-active, "
            "or stop the daemon)."
        )

    stats: Counter = Counter()
    notes: list[str] = []
    offsets: list[float] = []

    model_map = build_st_model_map(st_dir, args.source_label, stats)
    characters = [c.strip() for c in args.characters.split(",") if c.strip()]
    ledger = LedgerIndex(ledger_path, characters)

    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = character_dir / "backfill-backups" / f"model-{stamp}"

    targets: list[tuple[Path, str]] = []
    for path in sorted(segments_dir.glob("*.jsonl")):
        kind = "st" if path.name.startswith(f"{args.segment_prefix}_") else "ledger"
        targets.append((path, kind))
    if args.include_active:
        active = character_dir / "active.jsonl"
        if active.is_file():
            targets.append((active, "ledger"))

    rewritten: list[str] = []
    for path, kind in targets:
        if kind == "st":
            new_lines = stamp_st_file(path, model_map, stats, notes)
        else:
            new_lines = stamp_ledger_file(
                path, ledger, args.tolerance_seconds, args.ambiguity_seconds,
                stats, notes, offsets,
            )
        if new_lines is not None:
            rewritten.append(path.name)
            if args.apply:
                write_back(path, new_lines, backup_dir)

    report = {
        "apply": args.apply,
        "character_dir": str(character_dir),
        "archive_msg_ids_with_model": len(model_map),
        "ledger_voice_calls": len(ledger.calls),
        "files_modified": len(rewritten),
        "stats": dict(sorted(stats.items())),
        "join_offset_seconds": {
            "count": len(offsets),
            "max": max(offsets) if offsets else None,
            "median": sorted(offsets)[len(offsets) // 2] if offsets else None,
        },
        "notes": notes,
    }
    if args.apply and rewritten:
        report["backup_dir"] = str(backup_dir)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
