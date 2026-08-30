import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import recall_eval


class RecallEvalTest(unittest.TestCase):
    def history(self) -> str:
        root = tempfile.mkdtemp(prefix="shore-recall-eval-")
        path = str(Path(root) / "history.db")
        db = sqlite3.connect(path)
        db.executescript(
            """
            CREATE TABLE history_segments (
                character TEXT, idx INTEGER, committed INTEGER, excluded INTEGER
            );
            CREATE TABLE history_messages (
                character TEXT, segment INTEGER, ordinal INTEGER, timestamp TEXT,
                role TEXT, blocks_hash TEXT
            );
            CREATE TABLE history_blobs (
                hash TEXT, data BLOB, compressed INTEGER
            );
            INSERT INTO history_segments VALUES ('qifei', 1, 1, 0);
            """
        )
        messages = [
            (0, "user", "an earlier question"),
            (1, "assistant", "a long answer ending in the important topic"),
            (2, "user", "what about that?"),
        ]
        for ordinal, role, text in messages:
            key = f"b{ordinal}"
            body = json.dumps([{"type": "text", "text": text}]).encode()
            db.execute("INSERT INTO history_blobs VALUES (?, ?, 0)", (key, body))
            db.execute(
                "INSERT INTO history_messages VALUES ('qifei', 1, ?, ?, ?, ?)",
                (ordinal, f"2026-01-0{ordinal + 1}T00:00:00Z", role, key),
            )
        db.commit()
        db.close()
        return path

    def test_archived_turns_keep_only_immediate_assistant_context(self):
        turns = recall_eval.archived_turns(self.history(), "qifei")
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]["assistant_context"], "")
        self.assertEqual(
            turns[1]["assistant_context"],
            "a long answer ending in the important topic",
        )

    def test_query_variants_bound_the_assistant_share(self):
        variants = recall_eval.query_variants(
            {"user_text": "what about that?", "assistant_context": "0123456789"},
            4,
        )
        self.assertEqual(variants["user"], "what about that?")
        self.assertEqual(variants["assistant_tail"], "6789\n\nwhat about that?")
        self.assertEqual(variants["recent"], "0123456789\n\nwhat about that?")

    def test_review_rows_preserve_scores_and_leave_labels_blank(self):
        rows = recall_eval.review_rows(
            [
                {
                    "case_id": "seg1:m2",
                    "timestamp": "2026-01-03T00:00:00Z",
                    "user_text": "what about that?",
                    "assistant_context": "topic",
                    "variants": {
                        "user": {
                            "query": "what about that?",
                            "elapsed_ms": 20,
                            "results": [
                                {
                                    "id": "a",
                                    "text": "memory",
                                    "type": "world",
                                    "scores": {"final": 0.8, "semantic": None},
                                }
                            ],
                        }
                    },
                }
            ]
        )
        self.assertEqual(rows[0]["final"], 0.8)
        self.assertIsNone(rows[0]["semantic"])
        self.assertEqual(rows[0]["label"], "")

    def test_report_compares_top_three_with_the_tail(self):
        rows = []
        for rank, label in [(1, "useful"), (2, "distracting"), (4, "useful")]:
            rows.append(
                {
                    "case_id": "one",
                    "variant": "user",
                    "elapsed_ms": "100",
                    "error": "",
                    "rank": str(rank),
                    "label": label,
                }
            )
        text = recall_eval.report_text(rows)
        self.assertIn("top3: useful_hit=100%", text)
        self.assertIn("distracting_lines/turn=1.00", text)
        self.assertIn("ranks4-6: add_useful=100%", text)
        self.assertIn("only_useful_hit=0%", text)


if __name__ == "__main__":
    unittest.main()
