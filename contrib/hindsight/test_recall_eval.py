import json
import os
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

        def fake_chat(url, model, key, instruction, content, timeout, effort, max_tokens):
            calls.append(instruction)
            return "Context sentence naming Lake Eildon.", {"total_tokens": 42}

        original = recall_eval.chat
        recall_eval.chat = fake_chat
        try:
            queries, errors, metrics = recall_eval.rewrite_variants(
                {"user_text": "I was absolutely not laughing.", "recent_dialogue": []},
                {"rewrite_augment"},
                _args(),
            )
        finally:
            recall_eval.chat = original
        self.assertEqual(errors, {})
        self.assertEqual(metrics["rewrite_augment"]["usage"]["total_tokens"], 42)
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
            queries, errors, metrics = recall_eval.rewrite_variants(
                {"user_text": "where was it", "recent_dialogue": []},
                {"rewrite_replace"},
                _args(),
            )
        finally:
            recall_eval.chat = original
        self.assertEqual(queries["rewrite_replace"], "where was it")
        self.assertIn("fell back to raw", errors["rewrite_replace"])
        self.assertEqual(metrics["rewrite_replace"]["usage"], {})

    def test_retrieval_targets_ask_for_missing_memory_instead_of_paraphrase(self):
        def fake_chat(url, model, key, instruction, content, timeout, effort, max_tokens):
            self.assertIn("smallest piece of older information", instruction)
            self.assertIn("Do not ask who qifei or Ren are", instruction)
            self.assertIn("MEMORY.md", instruction)
            return "What happened between Vivian and Ren at the lake?", {}

        original = recall_eval.chat
        recall_eval.chat = fake_chat
        try:
            queries, errors, _metrics = recall_eval.rewrite_variants(
                {"user_text": "what about her?", "recent_dialogue": []},
                {"retrieval_targets"},
                _args(),
            )
        finally:
            recall_eval.chat = original
        self.assertEqual(errors, {})
        self.assertEqual(
            queries["retrieval_targets"],
            "What happened between Vivian and Ren at the lake?",
        )

    def test_refusal_detection_marks_rewrite_for_exclusion(self):
        self.assertEqual(
            recall_eval.refusal_reason({}, "stop", "I'm sorry, but I can't help."),
            "refusal-like response",
        )
        self.assertIn(
            "policy",
            recall_eval.refusal_reason({"refusal": "policy refusal"}, "stop", ""),
        )
        self.assertTrue(recall_eval.is_no_recall("  no_recall\n"))

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
                    "http://model.test/v1", "m", None, "instruction", "content", 5.0,
                    "max", 8192,
                )
        finally:
            urllib.request.urlopen = original
        self.assertIn("empty content", str(caught.exception))
        self.assertIn("finish_reason=length", str(caught.exception))

    def test_rewrite_request_uses_glm_53_reasoning_contract(self):
        import io
        import urllib.request

        payload = json.dumps(
            {"choices": [{"finish_reason": "stop", "message": {"content": "query"}}]}
        ).encode()
        captured = {}

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        def respond(request, **_kwargs):
            captured.update(json.loads(request.data))
            return Response(payload)

        original = urllib.request.urlopen
        urllib.request.urlopen = respond
        try:
            recall_eval.chat(
                "http://model.test/v1", "glm-5.3-flash", None,
                "instruction", "content", 5.0, "max", 8192,
            )
        finally:
            urllib.request.urlopen = original
        self.assertEqual(captured["reasoning_effort"], "max")
        self.assertEqual(captured["max_tokens"], 8192)
        self.assertNotIn("thinking", captured)
        self.assertNotIn("temperature", captured)

        captured.clear()
        urllib.request.urlopen = respond
        try:
            recall_eval.chat(
                "http://model.test/v1", "some-cheaper-model", None,
                "instruction", "content", 5.0, "default", 8192,
            )
        finally:
            urllib.request.urlopen = original
        self.assertNotIn("reasoning_effort", captured)

    def test_rewrite_provenance_records_model_prompt_and_budget(self):
        config = recall_eval.rewrite_config(_args(), {"user", "rewrite_replace"})
        self.assertEqual(config["model"], "glm-5.3-flash")
        self.assertEqual(config["reasoning_effort"], "max")
        self.assertEqual(config["max_tokens"], 8192)
        self.assertEqual(
            config["instructions"]["rewrite_replace"], recall_eval.REPLACE_INSTRUCTION
        )

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

    def test_review_samples_across_the_whole_time_range(self):
        cases = [{"case_id": str(index)} for index in range(10)]
        self.assertEqual(
            [case["case_id"] for case in recall_eval.evenly_sample(cases, 4)],
            ["0", "3", "6", "9"],
        )

    def test_comparison_review_uses_full_rewrite_context_and_only_top_n(self):
        case = _review_case()
        page = recall_eval.compare_review_html(
            [case], ["user", "rewrite_replace"], 2
        )
        self.assertIn("earlier user context", page)
        self.assertIn("earlier assistant context", page)
        self.assertIn("final question", page)
        self.assertIn("user memory one", page)
        self.assertNotIn("user memory three", page)
        self.assertIn("Neither is useful", page)
        self.assertIn("localStorage", page)
        self.assertNotIn("</script>inside memory", page)
        self.assertIn("<\\/script>inside memory", page)

    def test_calibration_review_only_contains_the_chosen_variant(self):
        page = recall_eval.calibration_review_html(
            [_review_case()], "rewrite_replace", 1
        )
        self.assertIn("rewritten memory one", page)
        self.assertNotIn("rewritten memory two", page)
        self.assertNotIn("user memory one", page)
        self.assertIn("score hidden until labelled", page)

    def test_compact_comparison_report_counts_neither_separately(self):
        text = recall_eval.comparison_report_text(
            {
                "variants": ["user", "rewrite_replace"],
                "total_cases": 4,
                "provenance": {
                    "model": "glm-5.3-flash",
                    "reasoning_effort": "max",
                    "max_tokens": 8192,
                    "prompt_version": 2,
                },
                "measurements": [
                    {
                        "variant": "rewrite_replace",
                        "elapsed_ms": 2200,
                        "rewrite_elapsed_ms": 1500,
                        "rewrite_usage": {"total_tokens": 1800},
                    }
                ],
                "judgments": [
                    {"winner": "user"},
                    {"winner": "rewrite_replace"},
                    {"winner": "rewrite_replace"},
                    {"winner": "neither"},
                ],
            }
        )
        self.assertIn("decided=4/4", text)
        self.assertIn("rewrite_replace    wins=2", text)
        self.assertIn("neither useful", text)
        self.assertIn("rewriter=glm-5.3-flash", text)
        self.assertIn("rewrite_p50=1500ms", text)
        self.assertIn("rewrite_tokens_total=1800", text)

    def test_review_rejects_untracked_rewrite_settings(self):
        with self.assertRaisesRegex(ValueError, "provenance is missing"):
            recall_eval.rewrite_provenance(
                [_review_case()], {"user", "rewrite_replace"}
            )

    def test_refresh_rewrites_reuses_baseline_without_recalling_it(self):
        import argparse

        root = Path(tempfile.mkdtemp(prefix="shore-refresh-rewrites-"))
        source = root / "old.jsonl"
        output = root / "new.jsonl"
        case = _review_case()
        case["timestamp"] = "2026-08-31T00:00:00Z"
        source.write_text(json.dumps(case) + "\n")
        calls = []

        def fake_rewrite(turn, wanted, args):
            return (
                {"rewrite_replace": "corrected query"},
                {},
                {"rewrite_replace": {"elapsed_ms": 1200, "usage": {"total_tokens": 900}}},
            )

        def fake_recall(url, bank, query, timestamp, max_tokens, timeout, api_key):
            calls.append(query)
            return {
                "results": [
                    {"id": "new", "text": "correct memory", "scores": {"reranker": 0.9}}
                ]
            }

        args = argparse.Namespace(
            input=str(source), output=str(output), cases=1, baseline="user",
            variants="rewrite_replace", character="qifei", url="http://hindsight",
            api_key=None, max_tokens=2048, timeout=10.0, user_name="Ren",
            rewrite_url="http://model/v1", rewrite_model="glm-5.3-flash",
            rewrite_reasoning_effort="max", rewrite_max_tokens=8192,
            rewrite_key_env="TEST_REWRITE_KEY", rewrite_timeout=120.0,
        )
        old_key = os.environ.get("TEST_REWRITE_KEY")
        os.environ["TEST_REWRITE_KEY"] = "test-key"
        original_rewrite = recall_eval.rewrite_variants
        original_recall = recall_eval.recall
        recall_eval.rewrite_variants = fake_rewrite
        recall_eval.recall = fake_recall
        try:
            self.assertEqual(recall_eval.refresh_rewrites(args), 0)
        finally:
            recall_eval.rewrite_variants = original_rewrite
            recall_eval.recall = original_recall
            if old_key is None:
                del os.environ["TEST_REWRITE_KEY"]
            else:
                os.environ["TEST_REWRITE_KEY"] = old_key
        repaired = json.loads(output.read_text())
        self.assertEqual(calls, ["corrected query"])
        self.assertEqual(repaired["variants"]["user"], case["variants"]["user"])
        self.assertEqual(repaired["variants"]["rewrite_replace"]["results"][0]["id"], "new")
        self.assertEqual(repaired["rewrite_config"]["prompt_version"], 4)

    def test_compact_calibration_report_reuses_threshold_analysis(self):
        text = recall_eval.calibration_report_text(
            {
                "variant": "rewrite_replace",
                "total_memories": 2,
                "judgments": [
                    {"label": "useful", "reranker": 0.9},
                    {"label": "distracting", "reranker": 0.01},
                ],
            }
        )
        self.assertIn("labels=2/2", text)
        self.assertIn("[min_scores calibration]", text)
        self.assertIn("kept_useful", text)


def _args():
    import argparse

    return argparse.Namespace(
        user_name="Ren",
        character="qifei",
        rewrite_url="http://model.test/v1",
        rewrite_model="glm-5.3-flash",
        rewrite_key=None,
        rewrite_timeout=5.0,
        rewrite_reasoning_effort="max",
        rewrite_max_tokens=8192,
    )


def _review_case():
    def results(prefix):
        return [
            {
                "id": f"{prefix}-{rank}",
                "text": (
                    "</script>inside memory"
                    if prefix == "user" and rank == 2
                    else f"{prefix} memory {['zero', 'one', 'two', 'three'][rank]}"
                ),
                "scores": {"reranker": rank / 10},
            }
            for rank in range(1, 4)
        ]

    return {
        "case_id": "seg1:m4",
        "user_text": "final question",
        "recent_dialogue": [
            {"role": "user", "text": "earlier user context"},
            {"role": "assistant", "text": "earlier assistant context"},
        ],
        "variants": {
            "user": {"query": "final question", "results": results("user")},
            "rewrite_replace": {
                "query": "standalone question",
                "results": results("rewritten"),
            },
        },
    }


if __name__ == "__main__":
    unittest.main()
