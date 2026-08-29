import json
import os
import sqlite3
import sys
import tempfile
import types
import unittest
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
                client = FakeClient(['{"added": 1}', RuntimeError("provider unavailable")])
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


if __name__ == "__main__":
    unittest.main()
