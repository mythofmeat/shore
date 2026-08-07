#!/usr/bin/env python3
"""Mutation pass over the heartbeat tick's delivery (#18 / #12).

The tick's two halves are mutated by `mutate_heartbeat_request.py` and
`mutate_heartbeat_loop.py`. What is left is the end of it: getting what the
character asked to say out of a conversation that is about to be thrown away.

Every step of that can fail on its own — the engine may refuse the append, no
client may be connected, the notifier may be absent — and the Rust let each fail
independently and carried on. Most mutants here collapse that into one failure
path, or move the notification inside it. The notification's placement is the one
that looks most like a tidy-up and is not: the character *did* speak, and a user
told about a message they cannot find is better served than one who is never
told.

The rest is the difference between "said nothing" and "said something empty".
A tick with no text and no images is a skip; a tick that returned an empty
string from a `sendMessage` tool call is a message. Only the tag can never
produce the empty string, so collapsing those two states loses a real one.

A mutant is KILLED if `bun test tests/heartbeat_tick.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_heartbeat_tick.py
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
T = "src/autonomy/heartbeat_tick.ts"

TESTS = ["tests/heartbeat_tick.test.ts"]

ENGINE_BLOCK = (
    "    try {\n"
    "      const engine = await deps.engine(character);\n"
    "      await engine.appendMessage(msg);\n"
    "      deps.emit?.(character, engine.currentRevision(), msg);\n"
    "    } catch (e) {\n"
    "      console.error(\n"
    "        `shore: heartbeat could not persist the autonomous message for ${character}: ${String(e)}`,\n"
    "      );\n"
    "    }"
)

# (label, file, find, replace)
MUTANTS = [
    # --- said something, or said nothing --------------------------------------
    ("skip: an image-only tick is treated as having said nothing",
     T,
     "  if (loop.sendMessageText === undefined && loop.images.length === 0) {",
     "  if (loop.sendMessageText === undefined) {"),
    ("skip: an empty sendMessage is collapsed into having said nothing",
     T,
     "  if (loop.sendMessageText === undefined && loop.images.length === 0) {",
     "  if ((loop.sendMessageText ?? \"\") === \"\" && loop.images.length === 0) {"),
    ("skip: every tick delivers, including the ones with nothing to deliver",
     T,
     "  if (loop.sendMessageText === undefined && loop.images.length === 0) {\n"
     "    note(\"message_skipped\", \"Tick completed — no message sent\");\n"
     "    return;\n"
     "  }",
     "  if (false as boolean) return;"),

    # --- the message ----------------------------------------------------------
    ("message: an image-only tick carries an empty text block beside the image",
     T,
     "  const text = loop.sendMessageText ?? \"\";",
     "  const text = loop.sendMessageText ?? \" \";"),
    ("message: the minting model is recorded as an empty string rather than absent",
     T,
     "    request.model === \"\" ? undefined : request.model,",
     "    request.model,"),
    ("message: the images lose their captions",
     T,
     "      ...(img.caption === undefined ? {} : { caption: img.caption }),",
     "      ...{},"),
    ("message: an absent caption is written as an explicit undefined",
     T,
     "      ...(img.caption === undefined ? {} : { caption: img.caption }),",
     "      caption: img.caption,"),
    ("message: the ring-buffer preview is unbounded",
     T,
     "  return [...text].slice(0, 80).join(\"\");",
     "  return text;"),

    # --- delivery -------------------------------------------------------------
    ("deliver: the message is pushed before it is persisted",
     T, ENGINE_BLOCK,
     "    try {\n"
     "      const engine = await deps.engine(character);\n"
     "      deps.emit?.(character, engine.currentRevision(), msg);\n"
     "      await engine.appendMessage(msg);\n"
     "    } catch (e) {\n"
     "      console.error(`shore: heartbeat could not persist for ${character}: ${String(e)}`);\n"
     "    }"),
    ("deliver: a failed append takes the whole tick down with it",
     T, ENGINE_BLOCK,
     "    const engine = await deps.engine(character);\n"
     "    await engine.appendMessage(msg);\n"
     "    deps.emit?.(character, engine.currentRevision(), msg);"),
    ("deliver: the notification only fires when the append succeeded",
     T,
     "  deps.notify?.(`Shore — ${character}`, msg.content);",
     "  if (deps.engine !== undefined) deps.notify?.(`Shore — ${character}`, msg.content);"),
    ("deliver: nothing is pushed, so connected clients never see the message",
     T,
     "      deps.emit?.(character, engine.currentRevision(), msg);",
     "      void engine;"),
    ("deliver: the message is never appended, only announced",
     T,
     "      await engine.appendMessage(msg);",
     "      void msg;"),
    ("deliver: the log line is written for a message that was never sent",
     T,
     "  note(\"message_sent\", `Autonomous message sent: ${shortPreview(msg.content)}`);",
     "  void msg;"),

    # --- the tick -------------------------------------------------------------
    ("tick: a body that cannot be built runs the loop anyway, on an empty one",
     T,
     "  const prepared = await prepareHeartbeatRequest(character, config, deps);\n"
     "  if (prepared === undefined) return { events };",
     "  const prepared = (await prepareHeartbeatRequest(character, config, deps)) ?? {\n"
     "    request: { messages: [] } as never,\n"
     "    maxToolIterations: undefined,\n"
     "    override: undefined,\n"
     "  };"),
    ("tick: a heartbeat reports a turn count, so its turns are marked covered",
     T,
     "  return { events };\n"
     "}",
     "  return { events, turnCount: 0 };\n"
     "}"),
    ("tick: the loop's tool lines are dropped from the tick's events",
     T,
     "    note: (detail) => note(\"tool_use\", detail),",
     "    note: () => {},"),
    ("tick: the grace rounds come from nowhere, so a nudge is never answered",
     T,
     "    wrapUpGrace: config.app.behavior.autonomy.heartbeat.wrap_up_grace_rounds,",
     "    wrapUpGrace: 0,"),
    ("tick: the round cap is dropped, leaving only the deadline",
     T,
     "    maxToolIterations: prepared.maxToolIterations,",
     "    maxToolIterations: undefined,"),
    ("tick: delivery reads a request the loop never ran against",
     T,
     "  await persistHeartbeatMessage(character, prepared.request, loop, deps, note);",
     "  await persistHeartbeatMessage(character, { model: \"\", messages: [] } as never, loop, deps, note);"),
]


def run_tests() -> bool:
    """True when the suite passes."""
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def main() -> int:
    if not run_tests():
        print("baseline is red — fix the suite before mutating", file=sys.stderr)
        return 2

    survivors = []
    for i, (label, rel, find, replace) in enumerate(MUTANTS, start=1):
        path = ROOT / rel
        original = path.read_text()
        if find not in original:
            print(f"{i:3}. ERROR mutant does not apply: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        if original.count(find) != 1:
            print(f"{i:3}. ERROR mutant is ambiguous: {label}", file=sys.stderr)
            survivors.append(label)
            continue
        path.write_text(original.replace(find, replace))
        try:
            killed = not run_tests()
        finally:
            path.write_text(original)
        print(f"{i:3}. {'kill' if killed else 'LIVE'}  {label}")
        if not killed:
            survivors.append(label)

    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} killed")
    for label in survivors:
        print(f"  SURVIVOR: {label}")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
