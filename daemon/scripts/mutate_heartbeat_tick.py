#!/usr/bin/env python3
"""Mutation pass over delivering what a heartbeat tick said: skips, failures,
the delivered message, and persisting before pushing.
"""
import sys

T = "src/autonomy/heartbeat_tick.ts"

TESTS = ["tests/heartbeat_tick.test.ts"]

ENGINE_BLOCK = (
    "    try {\n"
    "      const engine = await deps.engine(character);\n"
    "      await engine.appendMessage(msg);\n"
    "      deps.emit?.(character, engine.currentRevision(), msg, engine.thread ?? request.context?.thread ?? \"main\");\n"
    "    } catch (e) {\n"
    "      shoreLog.error(\n"
    "        `shore: heartbeat could not persist the autonomous message for ${character}: ${String(e)}`,\n"
    "      );\n"
    "    }"
)

MUTANTS = [
    # --- said something, or said nothing --------------------------------------
    ("skip: an image-only tick is treated as having said nothing",
     T,
     "  } else if (loop.sendMessageText === undefined && loop.images.length === 0) {",
     "  } else if (loop.sendMessageText === undefined) {"),
    ("skip: an empty sendMessage is collapsed into having said nothing",
     T,
     "  } else if (loop.sendMessageText === undefined && loop.images.length === 0) {",
     "  } else if ((loop.sendMessageText ?? \"\") === \"\" && loop.images.length === 0) {"),
    ("skip: every tick delivers, including the ones with nothing to deliver",
     T,
     "  } else if (loop.sendMessageText === undefined && loop.images.length === 0) {\n"
     "    note(\"message_skipped\", \"Tick completed — no message sent\");\n"
     "    return;\n"
     "  }",
     "  }"),
    ("failed: a failed round is reported as an ordinary quiet tick",
     T,
     "      \"call_failed\",",
     "      \"message_skipped\","),
    ("failed: a failed round is not reported at all, so the tick looks quiet",
     T,
     "  if (loop.failedRound !== undefined) {",
     "  if (false as boolean) {"),

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
     "  return Array.from(text).slice(0, 80).join(\"\");",
     "  return text;"),

    # --- delivery -------------------------------------------------------------
    ("deliver: the message is pushed before it is persisted",
     T, ENGINE_BLOCK,
     "    try {\n"
     "      const engine = await deps.engine(character);\n"
     "      deps.emit?.(character, engine.currentRevision(), msg, engine.thread ?? request.context?.thread ?? \"main\");\n"
     "      await engine.appendMessage(msg);\n"
     "    } catch (e) {\n"
     "      shoreLog.error(`shore: heartbeat could not persist for ${character}: ${String(e)}`);\n"
     "    }"),
    ("deliver: a failed append takes the whole tick down with it",
     T, ENGINE_BLOCK,
     "    const engine = await deps.engine(character);\n"
     "    await engine.appendMessage(msg);\n"
     "    deps.emit?.(character, engine.currentRevision(), msg, engine.thread ?? request.context?.thread ?? \"main\");"),
    ("deliver: the notification only fires when the append succeeded",
     T,
     "  deps.notify?.(`Shore - ${character}`, msg.content);",
     "  if (deps.engine !== undefined) deps.notify?.(`Shore - ${character}`, msg.content);"),
    ("deliver: nothing is pushed, so connected clients never see the message",
     T,
     "      deps.emit?.(character, engine.currentRevision(), msg, engine.thread ?? request.context?.thread ?? \"main\");",
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
     '\n\n    const prepared = await prepareHeartbeatRequest(character, config, { ...deps, thread });\n    if (prepared === undefined) return { events };',
     '  const prepared = (await prepareHeartbeatRequest(character, config, { ...deps, thread })) ?? {\n    request: { messages: [] } as never,\n    maxToolIterations: undefined,\n    override: undefined,\n    thread,\n    conversation: [],\n  };'),
    ("tick: a heartbeat reports a turn count, so its turns are marked covered",
     T,
     "    return { events };\n  });\n"
     "}",
     "    return { events, turnCount: 0 };\n  });\n"
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


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
