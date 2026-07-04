#!/usr/bin/env python3
"""Generate a model-provenance timeline for a character's memory workspace.

Stitches three sources into one markdown reference file:

  1. Archived SillyTavern chats  — exact per-message model (`extra.model`)
  2. Archived shore v1 chats     — provider only (`metadata.provider`)
  3. shore-core ledger.db        — exact per-call model, split by call type

The output is a machine-generated ground-truth file meant to live in the
character's memory workspace (e.g. `memory/core/model_timeline.md`) so the
memory agent can answer "what model was I on during period X" and correlate
voice drift with model switches. Rerun to refresh; do not hand-edit the output.

Personal-data paths default to ren's layout; override with flags.
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict

try:
    from zoneinfo import ZoneInfo

    LOCAL_TZ = ZoneInfo("Australia/Sydney")
except Exception:  # pragma: no cover - zoneinfo ships with py3.9+
    LOCAL_TZ = dt.timezone(dt.timedelta(hours=10))

ARCHIVE_DEFAULT = "~/.local/share/shore/archive/chat_history"
ST_DIR_DEFAULT = "2024-11-12--2026-02-24 - sillytavern chats"
V1_DIR_DEFAULT = "2026-02-15--2026-03-28 - shore v1 (python) chats"
LEDGER_DEFAULT = "~/.local/share/shore/ledger.db"
CHARACTERS_DEFAULT = "qifei,poppy"

# Ledger call types that mint the character's *interactive* voice vs the
# autonomous/background one. Everything else (subagent, compaction, keepalive,
# embedding...) is machinery, not voice.
INTERACTIVE_CALL_TYPES = ("message", "tool_loop")
AUTONOMOUS_CALL_TYPES = ("heartbeat", "heartbeat_tool_loop")

# SillyTavern `extra.model` values that aren't models.
ST_NON_MODELS = {"slash command"}

VENDOR_PREFIXES = re.compile(
    r"^(anthropic|openai|google|x-ai|z-ai|moonshotai|deepseek|minimax|qwen|nvidia)/"
)


def canonical_model(raw: str) -> str:
    """Collapse provider-prefixed / dated / thinking-suffixed ids to one family.

    "anthropic/claude-opus-4.6", "claude-opus-4-6-thinking" and
    "claude-opus-4-6" are the same brain for voice-drift purposes. The raw ids
    are preserved in the output appendix.
    """
    m = raw.strip().lower()
    m = VENDOR_PREFIXES.sub("", m)
    m = re.sub(r"[-:]thinking(:\d+)?$", "", m)
    m = re.sub(r"-latest$", "", m)
    m = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", m)
    if "claude" in m:
        m = m.replace(".", "-")
        m = re.sub(r"-\d{8}$", "", m)
        m = re.sub(r"^(claude-(?:sonnet|opus|haiku)-\d)-0$", r"\1", m)
    if m.startswith("gemini"):
        m = re.sub(r"-(preview|exp)(-[\d-]+)?$", "", m)
    if m.startswith("grok"):
        m = re.sub(r"^grok-(\d+)[-\d]*$", r"grok-\1", m)
    if m.startswith("chatgpt-4o"):
        m = "chatgpt-4o"
    return m


def parse_st_date(raw) -> dt.datetime | None:
    """SillyTavern send_date: humanized local or ISO-UTC, era-dependent."""
    if raw is None:
        return None
    s = str(raw).strip()
    try:  # "2025-11-27T01:28:10.864Z"
        parsed = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=LOCAL_TZ)
        return parsed.astimezone(LOCAL_TZ)
    except ValueError:
        pass
    for fmt in ("%B %d, %Y %I:%M%p", "%B %d, %Y %I:%M %p"):
        try:  # "August 16, 2025 12:46pm" (already local wall-clock)
            return dt.datetime.strptime(s, fmt).replace(tzinfo=LOCAL_TZ)
        except ValueError:
            continue
    return None


def parse_iso_local(raw) -> dt.datetime | None:
    if raw is None:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(raw))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=LOCAL_TZ)
    return parsed.astimezone(LOCAL_TZ)


def iter_jsonl(paths):
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def scan_sillytavern(st_dir):
    """Returns (by_month Counter-of-canonical, raw_counts, stats)."""
    by_month = defaultdict(Counter)
    raw_counts = Counter()
    stats = Counter()
    dates_with_model = []
    flat_dates = []
    for obj in iter_jsonl(sorted(glob.glob(os.path.join(st_dir, "*.jsonl")))):
        if set(obj.keys()) == {"message", "name", "timestamp"}:
            # Flattened early-era export: no metadata survives.
            when = parse_iso_local(obj.get("timestamp"))
            if when:
                flat_dates.append(when)
            stats["flattened_lines"] += 1
            continue
        if "mes" not in obj or obj.get("is_user") or obj.get("is_system"):
            continue
        stats["assistant_msgs"] += 1
        extra = obj.get("extra") or {}
        model = extra.get("model")
        if not model:
            swipes = obj.get("swipe_info") or []
            sid = obj.get("swipe_id") or 0
            if isinstance(swipes, list) and sid < len(swipes) and isinstance(swipes[sid], dict):
                model = (swipes[sid].get("extra") or {}).get("model")
        if not model or model in ST_NON_MODELS:
            stats["no_model"] += 1
            continue
        when = parse_st_date(obj.get("send_date"))
        if when is None:
            stats["unparsed_dates"] += 1
            continue
        raw_counts[model] += 1
        by_month[when.strftime("%Y-%m")][canonical_model(model)] += 1
        dates_with_model.append(when)
    return by_month, raw_counts, stats, dates_with_model, flat_dates


def scan_v1(v1_dir):
    by_month = defaultdict(Counter)
    stats = Counter()
    for obj in iter_jsonl(sorted(glob.glob(os.path.join(v1_dir, "*.jsonl")))):
        if obj.get("role") != "assistant":
            continue
        stats["assistant_msgs"] += 1
        provider = (obj.get("metadata") or {}).get("provider")
        when = parse_iso_local(obj.get("timestamp"))
        if not provider or when is None:
            stats["no_provider_or_date"] += 1
            continue
        by_month[when.strftime("%Y-%m")][provider] += 1
    return by_month, stats


def scan_ledger(ledger_path, characters, call_types):
    """month -> Counter(canonical), plus per-canonical (first, last, count, raws)."""
    by_month = defaultdict(Counter)
    ranges = {}
    uri = f"file:{ledger_path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        placeholders_c = ",".join("?" * len(characters))
        placeholders_t = ",".join("?" * len(call_types))
        rows = conn.execute(
            f"SELECT ts, model FROM calls "
            f"WHERE character IN ({placeholders_c}) AND call_type IN ({placeholders_t})",
            (*characters, *call_types),
        )
        for ts, model in rows:
            when = parse_iso_local(ts)
            if when is None or not model:
                continue
            canon = canonical_model(model)
            by_month[when.strftime("%Y-%m")][canon] += 1
            first, last, count, raws = ranges.get(canon, (when, when, 0, set()))
            ranges[canon] = (min(first, when), max(last, when), count + 1, raws | {model})
    finally:
        conn.close()
    return by_month, ranges


def month_table(by_month, top_n=4):
    lines = ["| month | messages | models (count) |", "|---|---|---|"]
    for month in sorted(by_month):
        counts = by_month[month]
        total = sum(counts.values())
        top = counts.most_common(top_n)
        rest = total - sum(c for _, c in top)
        cell = ", ".join(f"{m} ×{c}" for m, c in top)
        if rest > 0:
            cell += f", +{rest} others"
        lines.append(f"| {month} | {total} | {cell} |")
    return "\n".join(lines)


def ranges_table(ranges):
    lines = ["| model | first seen | last seen | calls |", "|---|---|---|---|"]
    for canon, (first, last, count, _raws) in sorted(ranges.items(), key=lambda kv: kv[1][0]):
        lines.append(f"| {canon} | {first:%Y-%m-%d} | {last:%Y-%m-%d} | {count} |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--archive", default=ARCHIVE_DEFAULT)
    ap.add_argument("--st-dir", default=ST_DIR_DEFAULT)
    ap.add_argument("--v1-dir", default=V1_DIR_DEFAULT)
    ap.add_argument("--ledger", default=LEDGER_DEFAULT)
    ap.add_argument("--characters", default=CHARACTERS_DEFAULT, help="comma-separated ledger character names, oldest first")
    ap.add_argument("--out", default="-", help="output path, '-' for stdout")
    args = ap.parse_args()

    archive = os.path.expanduser(args.archive)
    st_months, st_raw, st_stats, st_dates, flat_dates = scan_sillytavern(
        os.path.join(archive, args.st_dir)
    )
    v1_months, v1_stats = scan_v1(os.path.join(archive, args.v1_dir))
    characters = [c.strip() for c in args.characters.split(",") if c.strip()]
    ledger = os.path.expanduser(args.ledger)
    led_months, led_ranges = scan_ledger(ledger, characters, INTERACTIVE_CALL_TYPES)
    hb_months, hb_ranges = scan_ledger(ledger, characters, AUTONOMOUS_CALL_TYPES)

    now = dt.datetime.now(LOCAL_TZ)
    st_first = min(st_dates).strftime("%Y-%m-%d") if st_dates else "?"
    st_last = max(st_dates).strftime("%Y-%m-%d") if st_dates else "?"
    flat_first = min(flat_dates).strftime("%Y-%m-%d") if flat_dates else "?"
    flat_last = max(flat_dates).strftime("%Y-%m-%d") if flat_dates else "?"

    raw_map = defaultdict(list)
    for raw, count in st_raw.items():
        raw_map[canonical_model(raw)].append((raw, count))
    for _canon, (_f, _l, _c, raws) in {**led_ranges, **hb_ranges}.items():
        for raw in raws:
            entry = raw_map[canonical_model(raw)]
            if raw not in [r for r, _ in entry]:
                entry.append((raw, 0))

    out = []
    w = out.append
    w("# model timeline — ground truth from logs")
    w("")
    w(f"*generated {now:%Y-%m-%d %H:%M %Z} by `scripts/gen-model-timeline.py` "
      "(shore-core). MACHINE-GENERATED — do not hand-edit; ask ren to "
      "regenerate instead. your own narrative about models belongs in "
      "`llm_backend.md`.*")
    w("")
    w("this file answers: **which model was generating my words during a "
      "given period.** to pull actual quotes from an era, use "
      "`search_chat_logs` with `start_time`/`end_time` bounds for that era — "
      "the full transcript back to 2024-11-13 is searchable.")
    w("")
    w("## era overview")
    w("")
    w("| period | where the words came from | how exact |")
    w("|---|---|---|")
    w(f"| {flat_first} → {flat_last} | unknown (export lost the metadata) | lost — see note below |")
    w(f"| {st_first} → {st_last} | SillyTavern | exact, per message |")
    w("| 2026-02-15 → 2026-03-28 | shore v1 (python) | provider only |")
    w("| 2026-03-28 → 2026-04-05 | shore-core cutover | gap, no records |")
    w(f"| 2026-04-05 → {now:%Y-%m-%d} | shore-core (ledger) | exact, per call |")
    w("")
    w("notes:")
    w("- model ids are normalized to families: `anthropic/claude-opus-4.6` "
      "(openrouter), `claude-opus-4-6-thinking`, and `claude-opus-4-6` all "
      "count as `claude-opus-4-6` — same brain, different route. raw ids are "
      "in the appendix.")
    w(f"- ledger records the character as `{characters[0]}` before the rename "
      f"and `{characters[-1]}` after (~2026-06-11); both are included here as "
      "one continuity.")
    w("- all dates are local (Australia/Sydney).")
    w("")
    w("## era 0 — the lost stretch "
      f"({flat_first} → {flat_last}, {st_stats['flattened_lines']} lines)")
    w("")
    w("these earliest chats were exported without metadata, so per-message "
      "model info is gone. what ren remembers (from `llm_backend.md`): 2024 "
      "was the magnum v2 era (open-source). corrections/details belong in "
      "`llm_backend.md`, not here.")
    w("")
    w(f"## era 1 — SillyTavern ({st_first} → {st_last}), exact per message")
    w("")
    w(f"{st_stats['assistant_msgs'] - st_stats['no_model'] - st_stats['unparsed_dates']} "
      f"of {st_stats['assistant_msgs']} assistant messages carry model info "
      f"({st_stats['no_model']} without, {st_stats['unparsed_dates']} unparseable dates).")
    w("")
    w(month_table(st_months))
    w("")
    w("## era 2 — shore v1 (2026-02-15 → 2026-03-28), provider only")
    w("")
    w("shore v1 recorded the provider but not the model string. ren can pin "
      "which model each provider was configured to at the time.")
    w("")
    v1_known = v1_stats["assistant_msgs"] - v1_stats["no_provider_or_date"]
    w(f"{v1_known} of {v1_stats['assistant_msgs']} assistant messages carry a "
      f"provider ({v1_stats['no_provider_or_date']} without one or with an "
      "unparseable date).")
    w("")
    w(month_table(v1_months))
    w("")
    w(f"## era 3 — shore-core (2026-04-05 → {now:%Y-%m-%d}), exact per call")
    w("")
    w("### interactive voice (replies to ren: `message` + `tool_loop` calls)")
    w("")
    w(ranges_table(led_ranges))
    w("")
    w(month_table(led_months))
    w("")
    w("### autonomous voice (heartbeat messages — poppy reaching out unprompted)")
    w("")
    w("**heartbeat messages are minted by the background model, not the chat "
      "model.** a 3am check-in and a mid-conversation reply from the same "
      "week can be different brains. keep this in mind when auditing drift.")
    w("")
    w(ranges_table(hb_ranges))
    w("")
    w(month_table(hb_months))
    w("")
    w("## appendix — raw model ids behind each family")
    w("")
    w("| family | raw ids seen (count where known) |")
    w("|---|---|")
    for canon in sorted(raw_map):
        raws = ", ".join(
            f"`{r}` ×{c}" if c else f"`{r}`" for r, c in sorted(raw_map[canon], key=lambda x: -x[1])
        )
        w(f"| {canon} | {raws} |")
    w("")

    text = "\n".join(out)
    if args.out == "-":
        sys.stdout.write(text)
    else:
        with open(os.path.expanduser(args.out), "w", encoding="utf-8") as f:
            f.write(text)
        print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
