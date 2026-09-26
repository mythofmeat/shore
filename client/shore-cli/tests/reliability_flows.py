import fcntl
import json
import os
from pathlib import Path
import pty
import select
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest

BINARY = sys.argv.pop(1)


def environment(root):
    env = dict(os.environ, SHORE_TOKEN="test-token", SHORE_IMAGES="off", NO_COLOR="1", TERM="xterm-256color")
    for key in list(env):
        if key.startswith("SHORE_TUI_") or key in ["SHORE_THREAD", "SHORE_CHARACTER", "SHORE_ADDR"]:
            env.pop(key)
    for name in ["DATA", "CONFIG", "RUNTIME", "CACHE"]:
        env[f"SHORE_{name}_DIR"] = str(Path(root) / name.lower())
    return env


def message(text):
    return {"msg_id": "stable-message-id", "role": "assistant", "content": text, "content_blocks": [{"type": "text", "text": text}], "timestamp": "2026-09-10T00:00:00Z"}


def history_page(messages):
    return {"messages": messages, "active_start": 0, "cursor": 0, "next_before": 0,
            "has_more_before": False, "global_active_start": 0,
            "total_messages": len(messages), "total_turns": len(messages)}


def terminal_frame(rid, text):
    return {"type": "stream_end", "rid": rid, "content": text, "finish_reason": "end_turn", "is_final": True,
            "metadata": {"tokens": {"input": 0, "output": 1, "cache_read": 0, "cache_write": 0},
                         "timing": {"total_ms": 1, "ttft_ms": 1}, "model": "test"}}


def run_cli(args, respond, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL, edit=False, expect_request=True):
    with tempfile.TemporaryDirectory() as root, socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(5)
        seen, errors = [], []

        def serve():
            try:
                conn, _ = listener.accept()
                with conn:
                    conn.settimeout(5)
                    stream = conn.makefile("rwb")

                    def send(frame):
                        stream.write((json.dumps(frame) + "\n").encode())
                        stream.flush()

                    send({"type": "hello", "v": 1, "server_name": "test", "characters": []})
                    seen.append(json.loads(stream.readline()))
                    send({"type": "history", "messages": [], "config": {}, "selected_character": "ada", "selected_thread": "main", "revision": 1})
                    line = stream.readline()
                    if not line and not expect_request:
                        return
                    request = json.loads(line)
                    seen.append(request)
                    respond(request, send, stream, seen)
            except BaseException as error:
                errors.append(error)

        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        env = environment(root)
        if edit:
            editor = Path(root) / "editor.py"
            editor.write_text("import pathlib,sys\npathlib.Path(sys.argv[1]).write_text('revised content')\n")
            env["VISUAL"] = f"{sys.executable} {editor}"
        result = subprocess.run([BINARY, "--addr", f"127.0.0.1:{listener.getsockname()[1]}", "--character", "ada", *args],
                                env=env, stdin=stdin, stdout=stdout, stderr=subprocess.PIPE, timeout=12)
        worker.join(6)
        if errors:
            raise errors[0]
        if worker.is_alive():
            raise AssertionError("mock server did not finish")
        return result, seen


class ReliabilityFlows(unittest.TestCase):
    def test_cli_character_archives_preserve_server_paths_backups_and_complete_results(self):
        fixtures = json.loads((Path(__file__).parent / "fixtures" / "character_archives.json").read_text())
        commands = [["export", "ada", "--output", "/fixture/ada.tar.gz"], ["import", "/fixture/ada.tar.gz"], ["character", "delete", "ada", "--archive", "/fixture/ada.tar.gz", "--yes"]]
        for fixture, command in zip(fixtures, commands):
            for json_output in [False, True]:
                def respond(request, send, _stream, _seen):
                    self.assertEqual(request["name"], fixture["name"])
                    self.assertEqual(request["args"], fixture["input"])
                    send({"type": "command_output", "name": request["name"], "rid": request["rid"], "data": {**fixture["result"], "future_archive_detail": "retained"}})
                result, _ = run_cli([*command, *(["--json"] if json_output else [])], respond)
                self.assertEqual(result.returncode, 0, result.stderr)
                if json_output:
                    self.assertEqual(json.loads(result.stdout), {**fixture["result"], "future_archive_detail": "retained"})
                else:
                    self.assertIn(b"Imported character ada" if fixture["name"] == "import_character" else b"/fixture/ada.tar.gz", result.stdout)
            def malformed(request, send, _stream, _seen):
                send({"type": "command_output", "name": request["name"], "rid": request["rid"], "data": {"character": "ada"}})
            result, _ = run_cli([*command, "--json"], malformed)
            self.assertNotEqual(result.returncode, 0)
        def without_backup(request, send, _stream, _seen):
            self.assertEqual(request["args"], {"character": "ada", "confirm": "ada"})
            send({"type": "command_output", "name": request["name"], "rid": request["rid"], "data": {**fixtures[2]["result"], "archive": None}})
        result, _ = run_cli(["character", "delete", "ada", "--yes", "--json"], without_backup)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(json.loads(result.stdout)["archive"])
        result, seen = run_cli(["character", "delete", "ada"], without_backup, expect_request=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"--yes", result.stderr)
        self.assertEqual([request for request in seen if request["type"] == "command"], [])

    def test_cli_usage_filters_views_and_export_bytes(self):
        reports = json.loads((Path(__file__).parent / "fixtures" / "usage_reports.json").read_text())
        common = {"last": "all", "character": "ada", "provider": "anthropic", "api_key": "default", "model": "usage-model-a", "call_type": "message", "group_by": None, "budget": False, "anomalies": False, "export_csv": False, "export_tsv": False}
        cases = [([], {}, reports[0]), (["cache"], {}, reports[0]), (["limits"], {}, reports[0]), (["budgets"], {"budget": True}, reports[2]), (["anomalies"], {"anomalies": True}, reports[3]), (["export"], {"export_csv": True}, reports[4]), (["export", "--tsv"], {"export_tsv": True}, reports[5])]
        for dimension in ["model", "provider", "call_type", "kind", "api_key", "cost_source"]:
            cases.append((["by", dimension.replace("_", "-")], {"group_by": dimension}, {**reports[1], "dimension": dimension}))
        for command, mode, output in cases:
            def respond(request, send, _stream, _seen):
                self.assertEqual(request["name"], "usage")
                self.assertEqual(request["args"], {**common, **mode})
                send({"type": "command_output", "name": "usage", "rid": request["rid"], "data": output})
            result, _ = run_cli(["usage", *command, "--last=all", "--provider=anthropic", "--api-key=default", "--model=usage-model-a", "--call-type=message", "--json"], respond)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), output)
        for tab, output in [(False, reports[4]), (True, reports[5])]:
            def exported(request, send, _stream, _seen):
                self.assertEqual(request["args"]["export_tsv"], tab)
                self.assertEqual(request["args"]["export_csv"], not tab)
                send({"type": "command_output", "name": "usage", "rid": request["rid"], "data": output})
            result, _ = run_cli(["usage", "export", *(["--tsv"] if tab else [])], exported)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.decode(), output["data"])
        for output in [{"mode": "summary", "summary": []}, {**reports[2], "budgets": [{"name": "missing details"}]}]:
            def malformed(request, send, _stream, _seen):
                send({"type": "command_output", "name": "usage", "rid": request["rid"], "data": output})
            result, _ = run_cli(["usage", "--json"], malformed)
            self.assertNotEqual(result.returncode, 0)

    def test_cli_manual_tool_arguments_and_result_variants(self):
        reports = json.loads((Path(__file__).parent / "fixtures" / "tool_results.json").read_text())
        for output in reports:
            describe = "mode" in output
            args = ["debug", "tool", "fixture", "count=0", '--input={"entries":[{"text":"first\\nsecond","enabled":null}]}', "--raw", "--json"]
            if describe:
                args.append("--describe")
            def respond(request, send, _stream, _seen):
                self.assertEqual(request["name"], "run_tool")
                self.assertEqual(request["args"], {"tool": "fixture", "input": {"entries": [{"text": "first\nsecond", "enabled": None}]}, "pairs": {"count": "0"}, "raw": True, "describe": describe})
                send({"type": "command_output", "name": "run_tool", "rid": request["rid"], "data": output})
            result, _ = run_cli(args, respond)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), output)
        def subagent(request, send, _stream, _seen):
            self.assertEqual(request["args"], {"tool": "ask_worker", "input": {"query": "Find the notes"}, "pairs": {}, "raw": False})
            send({"type": "command_output", "name": "run_tool", "rid": request["rid"], "data": reports[3]})
        result, _ = run_cli(["debug", "subagent", "worker", "Find", "the", "notes", "--json"], subagent)
        self.assertEqual(result.returncode, 0, result.stderr)
        for output in [{"tool": "fixture", "ok": True}, {**reports[1], "raw": 1}]:
            def malformed(request, send, _stream, _seen):
                send({"type": "command_output", "name": "run_tool", "rid": request["rid"], "data": output})
            result, _ = run_cli(["debug", "tool", "fixture", "--json"], malformed)
            self.assertNotEqual(result.returncode, 0)

    def test_cli_memory_arguments_and_all_result_variants(self):
        fixtures = Path(__file__).parent / "fixtures"
        listing = json.loads((fixtures / "memory_segments.json").read_text())
        reports = json.loads((fixtures / "memory_compaction.json").read_text())
        segment = listing["segments"][0]
        clear = {"status": "clear", "character": "ada", "thread": "main", "message_count": 2, "segment": segment}
        cases = [
            (["segments", "--json"], "segments", {"action": "list"}, listing),
            (["segments", "show", "4", "--json"], "segments", {"action": "show", "index": 4}, {"character": "ada", "thread": "main", "segment": segment, "messages": []}),
            (["clear", "--json"], "clear", {"exclude": False, "note": None}, clear),
            (["clear", "--exclude", "--note=manual archive", "--json"], "clear", {"exclude": True, "note": "manual archive"}, clear),
        ]
        for action in ["include", "exclude", "label", "note"]:
            args = {"action": action, "index": 4}
            if action in ["label", "note"]:
                args["value"] = None
            cases.append((["segments", action, "4", "--json"], "segments", args, {"character": "ada", "thread": "main", "action": action, "segment": segment}))
        for report in reports:
            cases.append((["compact", "0", "--restart", "--json"], "compact", {"keep_turns": 0, "restart": True}, report))
        for args, name, expected, output in cases:
            with self.subTest(args=args, output=output):
                def respond(request, send, _stream, _seen):
                    self.assertEqual(request["name"], name)
                    self.assertEqual(request["args"], expected)
                    send({"type": "command_output", "name": name, "rid": request["rid"], "data": output})
                result, _ = run_cli(args, respond)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), output)
        for name, output in [("compact", {"status": "paused", "character": "ada"}), ("segments", {"segments": []}), ("clear", {"status": "clear"})]:
            def malformed(request, send, _stream, _seen):
                send({"type": "command_output", "name": name, "rid": request["rid"], "data": output})
            result, _ = run_cli([name, "--json"], malformed)
            self.assertNotEqual(result.returncode, 0)

    def test_request_scoped_warnings_reach_stderr(self):
        def respond(request, send, _stream, _seen):
            for warning in [
                {"type": "provider_warning", "message": "PROVIDER_DEGRADED"},
                {"type": "provider_fallback_warning", "provider": "test", "from_key": "one", "to_key": "two", "kind": "rate_limit", "message": "FALLBACK_USED"},
                {"type": "usage_warning", "budget": "daily", "message": "BUDGET_WARNING", "current_cost": 8, "cost_limit": 10, "percent_used": 80, "crossed_warn_at": [80], "period": "day", "period_start": "", "reset_at": ""},
                {"type": "config_warning", "path": "test.toml", "message": "CONFIG_WARNING"},
            ]:
                send({**warning, "rid": "other-request", "message": "UNRELATED_WARNING"})
                send({**warning, "rid": request["rid"]})
            send(terminal_frame(request["rid"], "reply"))
        result, _ = run_cli(["msg", "send", "hello"], respond)
        self.assertEqual(result.returncode, 0, result.stderr)
        for text in [b"PROVIDER_DEGRADED", b"FALLBACK_USED", b"BUDGET_WARNING", b"CONFIG_WARNING"]:
            self.assertIn(text, result.stderr)
        self.assertNotIn(b"UNRELATED_WARNING", result.stderr)

    def test_cli_model_selection_and_settings_keep_typed_targets_and_result_details(self):
        selection = {"target": "role", "active": "fixture", "qualified_name": "fixture", "provider": "test", "model_id": "fixture-id", "changed": True, "role": "heartbeat", "config_key": "defaults.background.heartbeat", "cleared": [], "file": "fixture.toml", "restart_required": [], "future_detail": "visible"}
        cases = [
            (["model", "use", "fixture", "--background=heartbeat"], "switch_model", {"name": "fixture", "background_task": "heartbeat"}, selection),
            (["model", "setting", "--json", "openrouter_provider", '{"order":["a"],"allow_fallbacks":false}', "--global", "--model=fixture"], "set_model_setting", {"name": "fixture", "key": "openrouter_provider", "value": '{"order":["a"],"allow_fallbacks":false}' , "scope": "global"}, {"changed": True, "scope": "global", "model": "fixture", "provider": "test", "model_id": "fixture-id", "key": "openrouter_provider", "value": '{"order":["a"],"allow_fallbacks":false}' }),
        ]
        for args, name, expected, output in cases:
            with self.subTest(args=args):
                def respond(request, send, _stream, _seen):
                    self.assertEqual(request["name"], name)
                    self.assertEqual(request["args"], expected)
                    send({"type": "command_output", "name": name, "rid": request["rid"], "data": output})
                result, _ = run_cli(args, respond)
                self.assertEqual(result.returncode, 0, result.stderr)
                if name == "set_model_setting":
                    self.assertEqual(json.loads(result.stdout), output)
                else:
                    self.assertIn(b"fixture", result.stdout)
        def malformed(request, send, _stream, _seen):
            send({"type": "command_output", "name": "switch_model", "rid": request["rid"], "data": {"target": "thread", "active": "fixture"}})
        result, _ = run_cli(["model", "use", "fixture"], malformed)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"missing field", result.stderr)

    def test_cli_diagnostic_filters_runtime_outcomes_and_full_results(self):
        fixtures = Path(__file__).parent / "fixtures"
        call = json.loads((fixtures / "diagnostic_call.json").read_text())
        status = json.loads((fixtures / "diagnostic_status.json").read_text())
        cases = [
            (["status", "--json"], "status", {}, status),
            (["trace", "calls", "2", "--wire", "--diff", "--against=1", "--json"], "call_log", {"id": 2, "wire": True, "diff": True, "against": 1}, call),
            (["trace", "calls", "--count=0", "--call-type=heartbeat", "--json"], "call_log", {"count": 0, "call_type": "heartbeat"}, {"enabled": True, "entries": []}),
            (["trace", "heartbeat", "--count=3", "--json"], "transcript", {"source": "heartbeat", "count": 3}, {"enabled": True, "source": "heartbeat", "entries": []}),
            (["trace", "subagent", "parent-1", "--json"], "subagent_trace", {"ids": ["parent-1"]}, {"character": "ada", "requested_ids": ["parent-1"], "entries": []}),
            (["trace", "errors", "--count=0", "--json"], "error_log", {"count": 0}, {key: {"count": 0, "recent": []} for key in ["errors", "key_fallbacks"]}),
            (["trace", "events", "--json"], "heartbeat_log", {"count": 20}, {"events": [{"timestamp": "now", "kind": "wake", "detail": "manual wake"}]}),
            (["debug", "heartbeat_tick_now"], "heartbeat_tick_now", {}, {"character": "ada", "status": "scheduled"}),
            (["debug", "heartbeat_status_dormant"], "heartbeat_set_dormant", {}, {"character": "ada", "status": "dormant"}),
            (["debug", "heartbeat_status_active"], "heartbeat_set_active", {}, {"character": "ada", "status": "active"}),
            (["debug", "keepalive_ping_now"], "keepalive_ping_now", {}, {"character": "ada", "status": "skipped", "reason": "No prefix"}),
            (["debug", "session_activate"], "session_activate", {}, {"character": "ada", "registered": False, "heartbeat": None, "keepalive": {"status": "unavailable", "detail": "No prefix"}}),
        ]
        for args, name, expected, output in cases:
            with self.subTest(args=args):
                def respond(request, send, _stream, _seen):
                    self.assertEqual(request["name"], name)
                    self.assertEqual(request["args"], expected)
                    send({"type": "command_output", "name": name, "rid": request["rid"], "data": output})
                result, _ = run_cli(args, respond)
                self.assertEqual(result.returncode, 0, result.stderr)
                if args[0] == "debug":
                    self.assertIn(b"ada", result.stdout)
                else:
                    self.assertEqual(json.loads(result.stdout), output)
        def malformed(request, send, _stream, _seen):
            send({"type": "command_output", "name": "call_log", "rid": request["rid"], "data": {"enabled": True, "call": {"id": 2}, "wire": []}})
        result, _ = run_cli(["trace", "calls", "2", "--json"], malformed)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"CallLogResult", result.stderr)

    def test_tui_model_target_and_reload_use_canonical_requests(self):
        with tempfile.TemporaryDirectory() as root, socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(5)
            address = "127.0.0.1:%s" % listener.getsockname()[1]
            ready = threading.Event()
            applied = threading.Event()
            model_changed = threading.Event()
            models = []
            diagnostic_requests = []
            memory_requests = []
            tool_requests = []
            usage_requests = []
            archive_requests = []
            stop = threading.Event()
            seen = []
            errors = []
            def serve():
                try:
                    conn, _ = listener.accept()
                    with conn:
                        conn.settimeout(.1)
                        stream = conn.makefile("rwb")
                        def send(value):
                            stream.write((json.dumps(value) + "\n").encode())
                            stream.flush()
                        send({"type": "hello", "v": 1, "server_name": "test", "characters": [{"name": "ada"}]})
                        stream.readline()
                        send({"type": "history", "messages": [], "config": {}, "selected_character": "ada", "selected_thread": "main", "revision": 1})
                        ready.set()
                        conn.settimeout(5)
                        while not stop.is_set():
                            raw = stream.readline()
                            if not raw:
                                break
                            request = json.loads(raw)
                            if request.get("type") != "command":
                                continue
                            name = request["name"]
                            if name == "config_reload":
                                seen.append(request)
                                apply = request.get("args", {}).get("apply") is True
                                data = {"applied": apply, "config_path": "fixture.toml", "character": "ada", "changed_prompt_files": ["SOUL.md"], "restart_required": []}
                                if apply:
                                    data["prompts_refreshed"] = request["args"].get("refresh_prompts", False)
                                send({"type": "command_output", "name": name, "rid": request["rid"], "data": data})
                                if apply:
                                    applied.set()
                            elif name == "switch_model":
                                models.append(request)
                                send({"type": "command_output", "name": name, "rid": request["rid"], "data": {"target": "role", "active": "fixture", "qualified_name": "fixture", "provider": "test", "model_id": "fixture-id", "changed": True, "role": "heartbeat", "config_key": "defaults.background.heartbeat", "cleared": [], "file": "fixture.toml", "restart_required": []}})
                                model_changed.set()
                            elif name == "call_log":
                                diagnostic_requests.append(request)
                                output = json.loads((Path(__file__).parent / "fixtures" / "diagnostic_call.json").read_text())
                                send({"type": "command_output", "name": name, "rid": request["rid"], "data": output})
                            elif name in ["export_character", "import_character"]:
                                archive_requests.append(request)
                                fixture = next(item for item in json.loads((Path(__file__).parent / "fixtures" / "character_archives.json").read_text()) if item["name"] == name)
                                self.assertEqual(request["args"], fixture["input"])
                                send({"type": "command_output", "name": name, "rid": request["rid"], "data": fixture["result"]})
                            elif name == "usage":
                                reports = json.loads((Path(__file__).parent / "fixtures" / "usage_reports.json").read_text())
                                args = request["args"]
                                if args != {"budget": True}:
                                    usage_requests.append(request)
                                index = 2 if args.get("budget") else 5 if args.get("export_tsv") else 4 if args.get("export_csv") else 1 if args.get("group_by") else 3 if args.get("anomalies") else 0
                                send({"type": "command_output", "name": name, "rid": request["rid"], "data": reports[index]})
                            elif name == "run_tool":
                                tool_requests.append(request)
                                reports = json.loads((Path(__file__).parent / "fixtures" / "tool_results.json").read_text())
                                output = reports[0 if request["args"].get("describe") else 1]
                                send({"type": "command_output", "name": name, "rid": request["rid"], "data": output})
                            elif name in ["compact", "segments", "clear"]:
                                memory_requests.append(request)
                                fixtures = Path(__file__).parent / "fixtures"
                                if name == "compact":
                                    output = json.loads((fixtures / "memory_compaction.json").read_text())[3]
                                elif name == "segments":
                                    output = json.loads((fixtures / "memory_segments.json").read_text())
                                else:
                                    output = {"status": "clear", "character": "ada", "thread": "main", "message_count": 2, "segment": None}
                                send({"type": "command_output", "name": name, "rid": request["rid"], "data": output})
                            else:
                                send({"type": "command_output", "name": name, "rid": request.get("rid"), "data": {}})
                except BaseException as error:
                    if not stop.is_set():
                        errors.append(error)
            worker = threading.Thread(target=serve, daemon=True)
            worker.start()
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 110, 0, 0))
            env = environment(root)
            frames = Path(root) / "frames.txt"
            env["SHORE_TUI_DEBUG_FRAMES"] = str(frames)
            def controlling_terminal():
                os.setsid()
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            proc = subprocess.Popen([BINARY, "--addr", address, "--character", "ada", "--thread", "main"], env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
            try:
                self.assertTrue(ready.wait(3), errors)
                deadline = time.monotonic() + .3
                while time.monotonic() < deadline:
                    if select.select([master], [], [], .01)[0]:
                        os.read(master, 65536)
                os.write(master, b"\x1b")
                time.sleep(.05)
                os.write(master, b":config reload\r")
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not applied.is_set():
                    if select.select([master], [], [], .01)[0]:
                        os.read(master, 65536)
                self.assertTrue(applied.is_set(), "TUI did not apply preview: %s; %s" % (seen, frames.read_text()[-3000:]))
                self.assertEqual(len(seen), 2)
                self.assertEqual(seen[1]["args"], {"apply": True, "refresh_prompts": False})
                self.assertNotEqual(seen[0]["rid"], seen[1]["rid"])
                os.write(master, b"\x1b")
                time.sleep(.05)
                os.write(master, b":model use fixture --background=heartbeat\r")
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and not model_changed.is_set():
                    if select.select([master], [], [], .01)[0]:
                        os.read(master, 65536)
                self.assertTrue(model_changed.is_set(), frames.read_text()[-3000:])
                self.assertEqual(len(models), 1)
                self.assertEqual(models[0]["args"], {"name": "fixture", "background_task": "heartbeat"})
                os.write(master, b"\x1b")
                time.sleep(.05)
                os.write(master, b":trace calls 2 --wire --diff --against=1 --json\r")
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    if select.select([master], [], [], .01)[0]:
                        os.read(master, 65536)
                    if diagnostic_requests and "fixture-call-2" in frames.read_text():
                        os.write(master, b"G")
                    if "still visible" in frames.read_text():
                        break
                self.assertEqual(len(diagnostic_requests), 1)
                self.assertEqual(diagnostic_requests[0]["args"], {"id": 2, "wire": True, "diff": True, "against": 1})
                self.assertIn("still visible", frames.read_text())
                for index, (command, expected, visible) in enumerate([
                    (b":compact 0 --restart --json\r", {"keep_turns": 0, "restart": True}, "checkpoint-1"),
                    (b":segments --json\r", {"action": "list"}, '"index": 4'),
                    (b":clear --exclude --note=archive --json\r", {"exclude": True, "note": "archive"}, '"status": "clear"'),
                ]):
                    frame_offset = len(frames.read_text())
                    confirmed = False
                    os.write(master, b"\x1b")
                    time.sleep(.05)
                    os.write(master, command)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], .01)[0]:
                            os.read(master, 65536)
                        if command.startswith((b":compact", b":clear")) and not confirmed and "[CONFIRM]" in frames.read_text()[frame_offset:]:
                            self.assertEqual(len(memory_requests), index)
                            os.write(master, b"\r")
                            confirmed = True
                        if len(memory_requests) > index:
                            os.write(master, b"G")
                        if visible in frames.read_text():
                            break
                    self.assertEqual(len(memory_requests), index + 1, frames.read_text()[-3000:])
                    self.assertEqual(memory_requests[index]["args"], expected)
                    self.assertIn(visible, frames.read_text())
                for index, (command, expected, visible) in enumerate([
                    (b":debug tool fixture --describe --json\r", {"tool": "fixture", "input": {}, "pairs": {}, "raw": False, "describe": True}, "Tool definition fixture"),
                    (b':debug tool fixture count=0 --input=\'{"active":false}\' --raw --json\r', {"tool": "fixture", "input": {"active": False}, "pairs": {"count": "0"}, "raw": True, "describe": False}, "Nested fixture output"),
                ]):
                    frame_offset = len(frames.read_text())
                    confirmed = False
                    os.write(master, b"\x1b")
                    time.sleep(.05)
                    os.write(master, command)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], .01)[0]:
                            os.read(master, 65536)
                        if index == 1 and not confirmed and "[CONFIRM]" in frames.read_text()[frame_offset:]:
                            self.assertEqual(len(tool_requests), index)
                            os.write(master, b"\r")
                            confirmed = True
                        if len(tool_requests) > index:
                            os.write(master, b"G")
                        if visible in frames.read_text():
                            break
                    self.assertEqual(len(tool_requests), index + 1, frames.read_text()[-3000:])
                    self.assertEqual(tool_requests[index]["args"], expected)
                    self.assertIn(visible, frames.read_text())
                    self.assertEqual(confirmed, index == 1)
                usage_defaults = {"last": None, "character": "ada", "provider": None, "api_key": None, "model": None, "call_type": None, "group_by": None, "budget": False, "anomalies": False, "export_csv": False, "export_tsv": False}
                for index, (command, expected, visible) in enumerate([
                    (b":usage --last all --provider anthropic --api-key default --model usage-model-a --call-type message --json\r", {"last": "all", "provider": "anthropic", "api_key": "default", "model": "usage-model-a", "call_type": "message"}, '"remaining": -2.75'),
                    (b":usage by cost-source --json\r", {"group_by": "cost_source"}, '"group": "pricing_catalog"'),
                    (b":usage budgets --json\r", {"budget": True}, '"remaining": -2.75'),
                    (b":usage anomalies --json\r", {"anomalies": True}, "unexpected_write"),
                    (b":usage export --json\r", {"export_csv": True}, '"mode": "csv"'),
                    (b":usage export --tsv --json\r", {"export_tsv": True}, '"mode": "tsv"'),
                ]):
                    frame_offset = len(frames.read_text())
                    scrolled = False
                    os.write(master, b"\x1b")
                    time.sleep(.05)
                    os.write(master, command)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], .01)[0]:
                            os.read(master, 65536)
                        if len(usage_requests) > index:
                            os.write(master, b"k" if scrolled else b"G")
                            scrolled = True
                        if visible in frames.read_text()[frame_offset:]:
                            break
                    self.assertEqual(len(usage_requests), index + 1, frames.read_text()[-3000:])
                    self.assertEqual(usage_requests[index]["args"], {**usage_defaults, **expected})
                    self.assertTrue(visible in frames.read_text()[frame_offset:], frames.read_text()[-3000:])
                for index, (command, visible) in enumerate([
                    (b":export ada --output /fixture/ada.tar.gz --json\r", "rebuild_from_archived_segments"),
                    (b":import /fixture/ada.tar.gz --json\r", "queued_for_rebuild_when_retain_is_enabled"),
                ]):
                    frame_offset = len(frames.read_text())
                    os.write(master, b"\x1b")
                    time.sleep(.05)
                    os.write(master, command)
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        if select.select([master], [], [], .01)[0]:
                            os.read(master, 65536)
                        if len(archive_requests) > index:
                            os.write(master, b"G")
                        if visible in frames.read_text()[frame_offset:]:
                            break
                    self.assertEqual(len(archive_requests), index + 1, frames.read_text()[-3000:])
                    self.assertTrue(visible in frames.read_text()[frame_offset:], frames.read_text()[-3000:])
                self.assertEqual(errors, [])
            finally:
                stop.set()
                if proc.poll() is None:
                    os.write(master, b"\x03")
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                os.close(master)
                os.close(slave)
                worker.join(timeout=2)

    def offline_tui(self, root, keys=b""):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        env = environment(root)
        frames = Path(root) / "frames.txt"
        env["SHORE_TUI_DEBUG_FRAMES"] = str(frames)
        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        proc = subprocess.Popen([BINARY, "--addr", "127.0.0.1:1", "--character", "ada", "--thread", "main"],
                                env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
        try:
            deadline = time.monotonic() + .6
            while time.monotonic() < deadline and proc.poll() is None:
                if select.select([master], [], [], .02)[0]:
                    os.read(master, 65536)
            self.assertIsNone(proc.poll(), "draft failures must not abort the TUI")
            if keys:
                os.write(master, keys)
                time.sleep(.1)
            os.write(master, b"\x03")
            proc.wait(timeout=3)
            return frames.read_text()
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            os.close(slave)
            os.close(master)

    def test_offline_startup_recovers_the_requested_conversation(self):
        with tempfile.TemporaryDirectory() as root:
            drafts = Path(root) / "data" / "drafts"
            self.offline_tui(root, b"DRAFT_BEFORE_CONNECT")
            frames = self.offline_tui(root)
            self.assertIn("DRAFT_BEFORE_CONNECT", frames)
            saved = [json.loads(path.read_text()) for path in drafts.glob("*/*.json")]
            self.assertEqual(len(saved), 1)
            self.assertEqual((saved[0]["character"], saved[0]["thread"]), ("ada", "main"))

    def test_offline_input_is_saved_under_the_requested_conversation(self):
        with tempfile.TemporaryDirectory() as root:
            self.offline_tui(root, b"OFFLINE_INPUT")
            saved = [json.loads(path.read_text()) for path in (Path(root) / "data" / "drafts").glob("*/*.json")]
            self.assertEqual(len(saved), 1)
            self.assertEqual((saved[0]["character"], saved[0]["thread"]), ("ada", "main"))
            self.assertEqual(saved[0]["text"], "OFFLINE_INPUT")

    def test_draft_storage_failure_keeps_the_tui_available(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / "data"
            data.mkdir()
            (data / "drafts").write_text("not a directory")
            frames = self.offline_tui(root, b"STILL_USABLE")
            self.assertIn("STILL_USABLE", frames)

    def test_json_ignores_live_messages_and_unrelated_results(self):
        def respond(request, send, _stream, _seen):
            send({"type": "new_message", "revision": 2, "character": "ada", **message("LIVE_CHAT_TEXT")})
            send({"type": "send_image", "path": "unsolicited.png"})
            send({"type": "command_output", "rid": "unrelated", "name": "log", "data": {"wrong": "id"}})
            send({"type": "command_output", "rid": request["rid"], "name": "status", "data": {"wrong": "name"}})
            send({"type": "command_output", "name": "log", "data": {"wrong": "untagged"}})
            send({"type": "command_output", "rid": request["rid"], "name": "log", "data": history_page([]) | {"future_metadata": "inspectable"}})
        result, _ = run_cli(["log", "--json"], respond)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), history_page([]) | {"future_metadata": "inspectable"})

    def test_log_rejects_a_malformed_typed_result(self):
        def respond(request, send, _stream, _seen):
            send({"type": "command_output", "rid": request["rid"], "name": "log", "data": {"messages": []}})
        result, _ = run_cli(["log", "--json"], respond)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"active_start", result.stderr)
        self.assertEqual(result.stdout, b"")

    def test_provider_results_are_validated_without_losing_additive_fields(self):
        for data, valid in [({"providers": [], "future_metadata": "inspectable"}, True), ({"providers": [{"name": "incomplete"}]}, False)]:
            with self.subTest(valid=valid):
                def respond(request, send, _stream, _seen):
                    send({"type": "command_output", "rid": request["rid"], "name": "list_providers", "data": data})
                result, seen = run_cli(["provider", "--json"], respond)
                self.assertEqual(seen[-1]["name"], "list_providers")
                if valid:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), data)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, b"")
                    self.assertIn(b"missing field", result.stderr)

    @unittest.skipUnless(Path("/dev/full").exists(), "/dev/full is Linux-specific")
    def test_stdout_failure_exits_unsuccessfully(self):
        def respond(request, send, _stream, _seen):
            send({"type": "command_output", "rid": request["rid"], "name": "log", "data": history_page([message("output")])})
        with open("/dev/full", "wb") as full:
            for args in [["log", "--json"], ["log"]]:
                result, _ = run_cli(args, respond, stdout=full)
                self.assertNotEqual(result.returncode, 0, args)
                self.assertIn(b"space", result.stderr.lower())

    def test_unrelated_stream_cannot_finish_send(self):
        def respond(request, send, _stream, _seen):
            send(terminal_frame("unrelated", "WRONG_STREAM"))
            send(terminal_frame(None, "UNTAGGED_STREAM"))
            send({"type": "stream_start", "rid": request["rid"]})
            send({"type": "stream_chunk", "rid": request["rid"], "text": "CORRECT_STREAM"})
            send(terminal_frame(request["rid"], "CORRECT_STREAM"))
        result, _ = run_cli(["msg", "send", "hello"], respond)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(b"CORRECT_STREAM", result.stdout)
        self.assertNotIn(b"WRONG_STREAM", result.stdout)
        self.assertNotIn(b"UNTAGGED_STREAM", result.stdout)

    def test_editor_saves_resolved_id_after_new_message_arrives(self):
        def respond(request, send, stream, seen):
            self.assertEqual(request["name"], "get")
            send({"type": "command_output", "rid": request["rid"], "name": "get", "data": message("original")})
            send({"type": "new_message", "revision": 2, "character": "ada", **{**message("arrived while editing"), "msg_id": "newer-message"}})
            edit = json.loads(stream.readline())
            seen.append(edit)
            send({"type": "command_output", "rid": edit["rid"], "name": "edit", "data": {"changed": True}})
        master, slave = pty.openpty()
        try:
            result, seen = run_cli(["msg", "edit", "last"], respond, stdin=slave, edit=True)
        finally:
            os.close(slave)
            os.close(master)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(seen[-1]["args"]["ref"], "stable-message-id")
        self.assertEqual(seen[-1]["args"]["content"], "revised content")

    def test_startup_error_restores_terminal(self):
        with tempfile.TemporaryDirectory() as root:
            master, slave = pty.openpty()
            before = termios.tcgetattr(slave)
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            try:
                env = environment(root)
                env["SHORE_TUI_FIXTURE"] = str(Path(root) / "missing.md")
                result = subprocess.run([BINARY], env=env, stdin=slave, stdout=slave, stderr=subprocess.PIPE, timeout=5)
                after = termios.tcgetattr(slave)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(after, before)
            finally:
                termios.tcsetattr(slave, termios.TCSANOW, before)
                os.close(slave)
                os.close(master)

    def test_images_off_never_probes_kitty(self):
        with tempfile.TemporaryDirectory() as root:
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
            def controlling_terminal():
                os.setsid()
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            proc = subprocess.Popen([BINARY, "--addr", "127.0.0.1:1"], env=environment(root),
                                    stdin=slave, stdout=slave, stderr=slave, preexec_fn=controlling_terminal)
            output = b""
            try:
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    if select.select([master], [], [], .05)[0]:
                        output += os.read(master, 65536)
                os.write(master, b"\x03")
                proc.wait(timeout=3)
                self.assertNotIn(b"a=q", output)
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
                os.close(slave)
                os.close(master)


if __name__ == "__main__":
    unittest.main()
