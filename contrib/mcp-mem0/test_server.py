import os
import sys
import types
import unittest


class FakeMCPServer:
    def __init__(self, _name):
        pass

    def tool(self):
        return lambda function: function


mcp = types.ModuleType("mcp")
mcp_server = types.ModuleType("mcp.server")
mcp_server_mcpserver = types.ModuleType("mcp.server.mcpserver")
mcp_server_mcpserver.MCPServer = FakeMCPServer
sys.modules.setdefault("mcp", mcp)
sys.modules.setdefault("mcp.server", mcp_server)
sys.modules.setdefault("mcp.server.mcpserver", mcp_server_mcpserver)

mem0_config = types.ModuleType("mem0_config")
mem0_config.build_memory = lambda: None
mem0_config.begin_llm_diagnostics = lambda: None
mem0_config.llm_diagnostics = lambda: None
sys.modules.setdefault("mem0_config", mem0_config)

os.environ.pop("MEM0_ADD_ATTEMPTS", None)
sys.path.insert(0, os.path.dirname(__file__))
import server


class FailingMemory:
    def __init__(self):
        self.calls = 0

    def add(self, **_arguments):
        self.calls += 1
        raise RuntimeError("provider unavailable")


class SuccessfulMemory:
    def __init__(self):
        self.calls = 0

    def add(self, **_arguments):
        self.calls += 1
        return {
            "results": [
                {"id": "one", "memory": "User likes brown switches", "event": "ADD"},
                {"id": "two", "memory": "User owns a Keychron", "event": "ADD"},
            ]
        }


class ServerTest(unittest.TestCase):
    def setUp(self):
        server.llm_diagnostics = lambda: None
        server._add_attempts = 1

    def test_add_does_not_retry_by_default(self):
        memory = FailingMemory()
        server._memory = memory
        with self.assertRaisesRegex(RuntimeError, "after 1 attempt"):
            server.add([{"role": "user", "content": "hello"}], "ada")
        self.assertEqual(memory.calls, 1)

    def test_add_returns_the_created_memory_text(self):
        server._memory = SuccessfulMemory()
        self.assertEqual(
            server.add([{"role": "user", "content": "hello"}], "ada"),
            {
                "added": 2,
                "memories": ["User likes brown switches", "User owns a Keychron"],
                "diagnostic": {},
            },
        )

    def test_empty_add_explains_that_the_model_found_nothing(self):
        server._memory = type("EmptyMemory", (), {"add": lambda self, **kwargs: {"results": []}})()
        server.llm_diagnostics = lambda: {
            "finish_reason": "stop",
            "content": '{"memory": []}',
            "refusal": None,
            "prompt_tokens": 120,
            "completion_tokens": 8,
            "reasoning_tokens": 40,
            "provider_response": {
                "id": "chatcmpl-test",
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": '{"memory": []}',
                            "refusal": None,
                            "reasoning_content": "No durable facts found.",
                        },
                    }
                ],
            },
        }
        self.assertEqual(
            server.add([{"role": "user", "content": "hello"}], "ada"),
            {
                "added": 0,
                "memories": [],
                "diagnostic": {
                    "finish_reason": "stop",
                    "prompt_tokens": 120,
                    "completion_tokens": 8,
                    "reasoning_tokens": 40,
                    "provider_response": {
                        "id": "chatcmpl-test",
                        "choices": [
                            {
                                "finish_reason": "stop",
                                "message": {
                                    "content": '{"memory": []}',
                                    "refusal": None,
                                    "reasoning_content": "No durable facts found.",
                                },
                            }
                        ],
                    },
                    "candidate_count": 0,
                    "empty_reason": "model_extracted_no_memories",
                },
            },
        )

    def test_empty_add_shows_candidates_mem0_did_not_commit(self):
        server._memory = type("EmptyMemory", (), {"add": lambda self, **kwargs: {"results": []}})()
        server.llm_diagnostics = lambda: {
            "finish_reason": "stop",
            "content": '{"memory": [{"text": "User owns a keyboard"}]}',
        }
        result = server.add([{"role": "user", "content": "hello"}], "ada")
        self.assertEqual(result["diagnostic"]["empty_reason"], "mem0_filtered_all_candidates")
        self.assertEqual(result["diagnostic"]["candidates"], ["User owns a keyboard"])

    def test_explicit_refusal_is_classified(self):
        server._memory = type("EmptyMemory", (), {"add": lambda self, **kwargs: {"results": []}})()
        server.llm_diagnostics = lambda: {
            "finish_reason": "stop",
            "content": "",
            "refusal": "I cannot process this conversation.",
            "provider_response": {"choices": []},
        }
        result = server.add([{"role": "user", "content": "hello"}], "ada")
        self.assertEqual(result["diagnostic"]["empty_reason"], "model_refused")

    def test_diagnostic_failure_does_not_retry_a_successful_commit(self):
        memory = SuccessfulMemory()
        server._memory = memory
        server._add_attempts = 3
        server.llm_diagnostics = lambda: object()
        result = server.add([{"role": "user", "content": "hello"}], "ada")
        self.assertEqual(result["added"], 2)
        self.assertEqual(memory.calls, 1)
        self.assertIn("AttributeError", result["diagnostic"]["diagnostic_error"])


if __name__ == "__main__":
    unittest.main()
