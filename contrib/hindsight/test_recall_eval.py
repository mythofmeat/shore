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


    def test_archived_turns_carry_recent_dialogue_for_the_rewriter(self):
        turns = recall_eval.archived_turns(self.history(), "qifei")
        self.assertEqual(
            [message["text"] for message in turns[1]["recent_dialogue"]],
            [
                "an earlier question",
                "a long answer ending in the important topic",
            ],
        )

    def test_dialogue_block_names_the_speakers(self):
        turn = {
            "recent_dialogue": [
                {"role": "user", "text": "where was it"},
                {"role": "assistant", "text": "the lake"},
            ]
        }
        self.assertEqual(
            recall_eval.dialogue_block(turn, "Ren", "qifei"),
            "Ren: where was it\nqifei: the lake",
        )

    def test_rewrite_augment_keeps_the_original_message_verbatim(self):
        calls = []

        def fake_chat(url, model, key, instruction, content, timeout):
            calls.append(instruction)
            return "Context sentence naming Lake Eildon."

        original = recall_eval.chat
        recall_eval.chat = fake_chat
        try:
            queries, errors = recall_eval.rewrite_variants(
                {"user_text": "I was absolutely not laughing.", "recent_dialogue": []},
                {"rewrite_augment"},
                _args(),
            )
        finally:
            recall_eval.chat = original
        self.assertEqual(errors, {})
        self.assertTrue(
            queries["rewrite_augment"].startswith("I was absolutely not laughing.")
        )
        self.assertIn("Lake Eildon", queries["rewrite_augment"])

    def test_rewrite_failure_falls_back_to_the_raw_message(self):
        def boom(*_args, **_kwargs):
            raise OSError("model unreachable")

        original = recall_eval.chat
        recall_eval.chat = boom
        try:
            queries, errors = recall_eval.rewrite_variants(
                {"user_text": "where was it", "recent_dialogue": []},
                {"rewrite_replace"},
                _args(),
            )
        finally:
            recall_eval.chat = original
        self.assertEqual(queries["rewrite_replace"], "where was it")
        self.assertIn("fell back to raw", errors["rewrite_replace"])

    def test_empty_completion_is_an_error_not_a_silent_passthrough(self):
        import io
        import urllib.request

        payload = json.dumps(
            {"choices": [{"finish_reason": "length", "message": {"content": ""}}]}
        ).encode()

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        original = urllib.request.urlopen
        urllib.request.urlopen = lambda *_a, **_k: Response(payload)
        try:
            with self.assertRaises(RuntimeError) as caught:
                recall_eval.chat(
                    "http://model.test/v1", "m", None, "instruction", "content", 5.0
                )
        finally:
            urllib.request.urlopen = original
        self.assertIn("empty content", str(caught.exception))
        self.assertIn("finish_reason=length", str(caught.exception))

    def test_report_separates_variants_without_labels(self):
        rows = [
            {"case_id": "a", "variant": "user", "rank": "1", "label": "", "reranker": "0.02"},
            {"case_id": "a", "variant": "rewrite_augment", "rank": "1", "label": "", "reranker": "0.40"},
            {"case_id": "b", "variant": "user", "rank": "1", "label": "", "reranker": "0.80"},
            {"case_id": "b", "variant": "rewrite_augment", "rank": "1", "label": "", "reranker": "0.10"},
        ]
        text = recall_eval.report_text(rows)
        self.assertIn("[score separation, no labels needed]", text)
        self.assertIn("beats_user", text)
        self.assertRegex(text, r"rewrite_augment\s+2\s+")
        self.assertRegex(text, r"rewrite_augment.*\s50%")

    def test_report_calibrates_a_min_scores_floor(self):
        rows = [
            {"case_id": "a", "variant": "user", "rank": "1", "label": "useful", "reranker": "0.90"},
            {"case_id": "a", "variant": "user", "rank": "2", "label": "useful", "reranker": "0.60"},
            {"case_id": "a", "variant": "user", "rank": "3", "label": "distracting", "reranker": "0.002"},
            {"case_id": "a", "variant": "user", "rank": "4", "label": "harmless", "reranker": "0.001"},
        ]
        text = recall_eval.report_text(rows)
        self.assertIn("[min_scores calibration]", text)
        self.assertIn("useful       n=2", text)
        self.assertIn("0.100    100%         0%", text)


def _args():
    import argparse

    return argparse.Namespace(
        user_name="Ren",
        character="qifei",
        rewrite_url="http://model.test/v1",
        rewrite_model="glm-5.3-flash",
        rewrite_key=None,
        rewrite_timeout=5.0,
    )


if __name__ == "__main__":
    unittest.main()
