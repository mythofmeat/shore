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
                    index=0,
                    finish_reason="stop",
                    message=SimpleNamespace(
                        role="assistant",
                        content='{"memory": []}',
                        refusal=None,
                        reasoning_content="There are no durable facts in this exchange.",
                    ),
                )
            ],
            id="chatcmpl-test",
            object="chat.completion",
            created=1787990000,
            model="glm-5.3-flash",
            usage=SimpleNamespace(
                prompt_tokens=101,
                completion_tokens=12,
                total_tokens=113,
                completion_tokens_details=SimpleNamespace(reasoning_tokens=7),
            ),
        )
        mem0_config._capture_response(None, response, {})
        captured = mem0_config.llm_diagnostics()
        self.assertEqual(captured["finish_reason"], "stop")
        self.assertEqual(captured["content"], '{"memory": []}')
        self.assertIsNone(captured["refusal"])
        self.assertEqual(
            captured["reasoning_content"],
            "There are no durable facts in this exchange.",
        )
        self.assertEqual(captured["prompt_tokens"], 101)
        self.assertEqual(captured["completion_tokens"], 12)
        self.assertEqual(captured["reasoning_tokens"], 7)
        response_payload = captured["provider_response"]
        self.assertEqual(response_payload["id"], "chatcmpl-test")
        self.assertEqual(response_payload["model"], "glm-5.3-flash")
        self.assertEqual(
            response_payload["choices"][0]["message"]["reasoning_content"],
            "There are no durable facts in this exchange.",
        )


if __name__ == "__main__":
    unittest.main()
