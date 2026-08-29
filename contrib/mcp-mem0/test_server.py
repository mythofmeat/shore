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
    def add(self, **_arguments):
        return {
            "results": [
                {"id": "one", "memory": "User likes brown switches", "event": "ADD"},
                {"id": "two", "memory": "User owns a Keychron", "event": "ADD"},
            ]
        }


class ServerTest(unittest.TestCase):
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
            },
        )


if __name__ == "__main__":
    unittest.main()
