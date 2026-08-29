import io
import json
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace

zstandard = types.ModuleType("zstandard")
zstandard.ZstdError = ValueError
zstandard.ZstdDecompressor = object
sys.modules.setdefault("zstandard", zstandard)

mcp = types.ModuleType("mcp")
mcp_client = types.ModuleType("mcp.client")
mcp_client_client = types.ModuleType("mcp.client.client")
mcp_client_client.Client = object
sys.modules.setdefault("mcp", mcp)
sys.modules.setdefault("mcp.client", mcp_client)
sys.modules.setdefault("mcp.client.client", mcp_client_client)

sys.path.insert(0, os.path.dirname(__file__))
import backfill


def archived(position, text="hello"):
    segment, ordinal = position
    return backfill.ArchivedMessage(
        backfill.Position(segment, ordinal),
        "user",
        f"2026-08-{segment + 1:02d}T10:00:00Z",
        text,
    )


class BackfillQueryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.history = os.path.join(self.temp.name, "history.db")
        db = sqlite3.connect(self.history)
        db.executescript(
            """
            CREATE TABLE history_segments (
                character TEXT, idx INTEGER, committed INTEGER, excluded INTEGER
            );
            CREATE TABLE history_messages (
                character TEXT, segment INTEGER, ordinal INTEGER, role TEXT,
                timestamp TEXT, blocks_hash TEXT
            );
            CREATE TABLE history_blobs (
                hash TEXT, data BLOB, size INTEGER, compressed INTEGER
            );
            """
        )
        for segment, excluded in [(0, 0), (1, 0), (2, 1)]:
            db.execute(
                "INSERT INTO history_segments VALUES (?, ?, 1, ?)",
                ("ada", segment, excluded),
            )
            for ordinal in range(2):
                body = json.dumps([{"type": "text", "text": f"s{segment}m{ordinal}"}]).encode()
                digest = f"{segment}-{ordinal}"
                db.execute(
                    "INSERT INTO history_blobs VALUES (?, ?, ?, 0)",
                    (digest, body, len(body)),
                )
                db.execute(
                    "INSERT INTO history_messages VALUES (?, ?, ?, 'user', ?, ?)",
                    (
                        "ada",
                        segment,
                        ordinal,
                        f"2026-08-{segment + 1:02d}T10:00:00Z",
                        digest,
                    ),
                )
        db.commit()
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def test_reads_backward_below_the_activation_boundary(self):
        messages = backfill.read_messages(
            self.history,
            "ada",
            backfill.Position(1, 1),
            None,
            "",
            20,
        )
        self.assertEqual(
            [message.position for message in messages],
            [
                backfill.Position(1, 1),
                backfill.Position(1, 0),
                backfill.Position(0, 1),
                backfill.Position(0, 0),
            ],
        )

    def test_cursor_and_date_can_widen_backward_without_repeating(self):
        recent = backfill.read_messages(
            self.history,
            "ada",
            backfill.Position(1, 1),
            None,
            "2026-08-02",
            20,
        )
        older = backfill.read_messages(
            self.history,
            "ada",
            backfill.Position(1, 1),
            recent[-1].position,
            "2026-08-01",
            20,
        )
        self.assertEqual([message.position.segment for message in recent], [1, 1])
        self.assertEqual([message.position.segment for message in older], [0, 0])

    def test_batches_are_bounded_and_never_cross_segments(self):
        messages = [
            archived((2, 1)),
            archived((2, 0)),
            archived((1, 1)),
            archived((1, 0)),
        ]
        batches = backfill.make_batches(messages, batch_size=8, maximum=1)
        self.assertEqual(len(batches), 1)
        self.assertEqual({message.position.segment for message in batches[0].messages}, {2})

    def test_add_result_keeps_the_memory_text(self):
        result = SimpleNamespace(
            isError=False,
            content=[
                SimpleNamespace(
                    text=(
                        '{"added": 2, "memories": ["one", "two"], '
                        '"diagnostic": {"finish_reason": "stop"}}'
                    )
                )
            ],
        )
        self.assertEqual(backfill.add_result(result), (2, ["one", "two"], {"finish_reason": "stop"}))


class FakeClient:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)

    async def call_tool(self, _tool, _arguments):
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return SimpleNamespace(isError=False, content=[SimpleNamespace(text=outcome)])


class BackfillCheckpointTest(unittest.IsolatedAsyncioTestCase):
    async def test_failure_does_not_advance_past_the_failed_batch(self):
        with tempfile.TemporaryDirectory() as store:
            previous = backfill.STORE
            backfill.STORE = store
            try:
                state = {
                    "version": 2,
                    "characters": {
                        "ada": {
                            "through": {"segment": 2, "ordinal": 1},
                            "before": None,
                        }
                    },
                }
                saved = state["characters"]["ada"]
                batches = [
                    backfill.Batch([archived((2, 1))], backfill.Position(2, 1)),
                    backfill.Batch([archived((1, 1))], backfill.Position(1, 1)),
                ]
                client = FakeClient(
                    ['{"added": 1, "memories": ["new memory"]}', RuntimeError("provider unavailable")]
                )
                with self.assertRaisesRegex(RuntimeError, "provider unavailable"):
                    await backfill.ingest(client, "ada", batches, state, saved)
                with open(backfill.state_path()) as handle:
                    persisted = json.load(handle)
                self.assertEqual(
                    persisted["characters"]["ada"]["before"],
                    {"segment": 2, "ordinal": 1},
                )
            finally:
                backfill.STORE = previous

    async def test_empty_result_is_saved_but_does_not_advance(self):
        with tempfile.TemporaryDirectory() as store:
            previous = backfill.STORE
            backfill.STORE = store
            try:
                state = {
                    "version": 2,
                    "characters": {
                        "ada": {
                            "through": {"segment": 2, "ordinal": 1},
                            "before": {"segment": 2, "ordinal": 1},
                        }
                    },
                }
                saved = state["characters"]["ada"]
                batch = backfill.Batch([archived((1, 1))], backfill.Position(1, 1))
                client = FakeClient(
                    [
                        json.dumps(
                            {
                                "added": 0,
                                "memories": [],
                                "diagnostic": {
                                    "empty_reason": "model_extracted_no_memories",
                                    "provider_response": {
                                        "choices": [
                                            {
                                                "message": {
                                                    "content": '{"memory": []}',
                                                    "refusal": None,
                                                    "reasoning_content": "No durable facts found.",
                                                }
                                            }
                                        ]
                                    },
                                },
                            }
                        )
                    ]
                )
                output = io.StringIO()
                with redirect_stdout(output):
                    await backfill.ingest(client, "ada", [batch], state, saved)
                self.assertEqual(saved["before"], {"segment": 2, "ordinal": 1})
                self.assertEqual(saved["last_empty"]["next_before"], {"segment": 1, "ordinal": 1})
                self.assertEqual(saved["last_empty"]["attempts"], 1)
                self.assertIn("cursor remains 2:1", output.getvalue())
                self.assertIn("model explicitly extracted no memories", output.getvalue())
                self.assertIn("NOT CHECKPOINTED", output.getvalue())
                self.assertIn("No durable facts found.", output.getvalue())

                with open(backfill.state_path()) as handle:
                    persisted = json.load(handle)
                self.assertEqual(
                    persisted["characters"]["ada"]["before"],
                    {"segment": 2, "ordinal": 1},
                )
            finally:
                backfill.STORE = previous

    async def test_successful_retry_clears_empty_record_and_advances(self):
        with tempfile.TemporaryDirectory() as store:
            previous = backfill.STORE
            backfill.STORE = store
            try:
                batch = backfill.Batch([archived((1, 1))], backfill.Position(1, 1))
                state = {
                    "version": 2,
                    "characters": {
                        "ada": {
                            "through": {"segment": 2, "ordinal": 1},
                            "before": {"segment": 2, "ordinal": 1},
                            "last_empty": {
                                "cursor_before_attempt": {"segment": 2, "ordinal": 1},
                                "next_before": {"segment": 1, "ordinal": 1},
                                "messages": backfill.pending_signature(batch),
                                "attempts": 1,
                            },
                        }
                    },
                }
                saved = state["characters"]["ada"]
                await backfill.ingest(
                    FakeClient(['{"added": 1, "memories": ["retried memory"]}']),
                    "ada",
                    [batch],
                    state,
                    saved,
                )
                self.assertEqual(saved["before"], {"segment": 1, "ordinal": 1})
                self.assertNotIn("last_empty", saved)
            finally:
                backfill.STORE = previous


class BackfillRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = backfill.STORE
        backfill.STORE = self.temp.name
        self.state = {
            "version": 2,
            "characters": {
                "ada": {
                    "through": {"segment": 700, "ordinal": 57},
                    "before": {"segment": 700, "ordinal": 29},
                }
            },
        }
        self.saved = self.state["characters"]["ada"]

    def tearDown(self):
        backfill.STORE = self.previous
        self.temp.cleanup()

    def test_accept_empty_advances_without_a_client(self):
        self.saved["last_empty"] = {
            "cursor_before_attempt": {"segment": 700, "ordinal": 29},
            "next_before": {"segment": 700, "ordinal": 21},
            "messages": [],
        }
        position = backfill.accept_empty(self.state, self.saved)
        self.assertEqual(position, backfill.Position(700, 21))
        self.assertEqual(self.saved["before"], {"segment": 700, "ordinal": 21})
        self.assertNotIn("last_empty", self.saved)

    def test_rewind_moves_toward_boundary_for_recovery(self):
        backfill.rewind_before(
            self.state,
            self.saved,
            backfill.Position(700, 57),
            backfill.Position(700, 45),
        )
        self.assertEqual(self.saved["before"], {"segment": 700, "ordinal": 45})

    def test_rewind_refuses_to_move_farther_back(self):
        with self.assertRaisesRegex(RuntimeError, "must be newer"):
            backfill.rewind_before(
                self.state,
                self.saved,
                backfill.Position(700, 57),
                backfill.Position(700, 20),
            )

    def test_pending_batch_must_be_retried_with_the_same_messages(self):
        expected = backfill.Batch([archived((700, 28))], backfill.Position(700, 28))
        different = backfill.Batch([archived((700, 27))], backfill.Position(700, 27))
        self.saved["last_empty"] = {
            "cursor_before_attempt": {"segment": 700, "ordinal": 29},
            "next_before": {"segment": 700, "ordinal": 28},
            "messages": backfill.pending_signature(expected),
            "attempts": 1,
        }
        with self.assertRaisesRegex(RuntimeError, "next batch differs"):
            backfill.validate_pending_batch(self.saved, different)


if __name__ == "__main__":
    unittest.main()
