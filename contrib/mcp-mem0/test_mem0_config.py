import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import mem0_config


class ResponseDiagnosticTest(unittest.TestCase):
    def test_callback_captures_content_finish_reason_and_usage(self):
        mem0_config.begin_llm_diagnostics()
        response = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    finish_reason="stop",
                    message=SimpleNamespace(content='{"memory": []}'),
                )
            ],
            usage=SimpleNamespace(
                prompt_tokens=101,
                completion_tokens=12,
                completion_tokens_details=SimpleNamespace(reasoning_tokens=7),
            ),
        )
        mem0_config._capture_response(None, response, {})
        self.assertEqual(
            mem0_config.llm_diagnostics(),
            {
                "finish_reason": "stop",
                "content": '{"memory": []}',
                "prompt_tokens": 101,
                "completion_tokens": 12,
                "reasoning_tokens": 7,
            },
        )


if __name__ == "__main__":
    unittest.main()
