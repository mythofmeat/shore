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
    return {"msg_id": "stable-message-id", "role": "assistant", "content": text, "timestamp": "2026-09-10T00:00:00Z"}


def terminal_frame(rid, text):
    return {"type": "stream_end", "rid": rid, "content": text, "finish_reason": "end_turn", "is_final": True,
            "metadata": {"tokens": {"input": 0, "output": 1, "cache_read": 0, "cache_write": 0},
                         "timing": {"total_ms": 1, "ttft_ms": 1}, "model": "test"}}


def run_cli(args, respond, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL, edit=False):
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
                    request = json.loads(stream.readline())
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
    def test_json_ignores_live_messages_and_unrelated_results(self):
        def respond(request, send, _stream, _seen):
            send({"type": "new_message", "revision": 2, "character": "ada", **message("LIVE_CHAT_TEXT")})
            send({"type": "send_image", "path": "unsolicited.png"})
            send({"type": "command_output", "rid": "unrelated", "name": "log", "data": {"wrong": "id"}})
            send({"type": "command_output", "rid": request["rid"], "name": "status", "data": {"wrong": "name"}})
            send({"type": "command_output", "name": "log", "data": {"wrong": "untagged"}})
            send({"type": "command_output", "rid": request["rid"], "name": "log", "data": {"messages": []}})
        result, _ = run_cli(["log", "--json"], respond)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"messages": []})

    @unittest.skipUnless(Path("/dev/full").exists(), "/dev/full is Linux-specific")
    def test_stdout_failure_exits_unsuccessfully(self):
        def respond(request, send, _stream, _seen):
            send({"type": "command_output", "rid": request["rid"], "name": "log", "data": {"messages": [message("output")]}})
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
