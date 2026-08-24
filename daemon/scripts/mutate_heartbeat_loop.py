#!/usr/bin/env python3
"""Mutation pass over the heartbeat tool loop (#18 / #12).

A heartbeat's conversation is thrown away when the tick ends. Only two things
survive it: what the character wrote to disk with a workspace tool, and whatever
it asked to say, along with the reasoning behind it. So every mutant here still completes a tick — the model is
called, tools run, nothing throws — and what changes is whether those two things
make it out.

Three groups.

**The send-message sink.** The most expensive silence in the module. A character
that asked to speak and was not heard looks identical to one that had nothing to
say: the tick logs "no message sent" and the user is never told their character
tried. The tag is last-wins, a tool call beats a tag in the same round, and both
are read off responses that do not finish on `tool_use`. The reasoning from the
round that produced the message rides out with it: an autonomous turn stored
without it is a reasoning-free assistant turn in every later chat request, which
is what makes a reasoning model stop thinking for the rest of the conversation.

**The budget.** Reaching the round cap buys a grace window rather than ending the
loop, and only the wall clock is allowed to cut that window short. A loop that
stops at the cap cuts the model off mid-task with nothing written down, and the
work is gone with the conversation.

**The two undeclared tools.** `set_next_wake` and `sendMessage` are absent from
the tools array on purpose — declaring them would make the heartbeat's array
differ from chat's and give up the prompt-cache prefix a tick runs against. The
interception is what makes them work anyway, and the mutants here are the ways
it stops.

A mutant is KILLED if `bun test tests/heartbeat_loop.test.ts` fails with it
applied.

Run from the repository root:
    python3 daemon/scripts/mutate_heartbeat_loop.py
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
L = "src/autonomy/heartbeat_loop.ts"

TESTS = ["tests/heartbeat_loop.test.ts"]

# (label, file, find, replace)
MUTANTS = [
    # --- the send-message sink ------------------------------------------------
    ("send: the tag is first-wins, so a reconsidered message never replaces the draft",
     L,
     "    if (tagged !== undefined) {\n"
     "      sendMessageText = tagged;\n"
     "      messageThinking = thinking;\n"
     "    }",
     "    if (tagged !== undefined && sendMessageText === undefined) {\n"
     "      sendMessageText = tagged;\n"
     "      messageThinking = thinking;\n"
     "    }"),
    ("send: a sendMessage tool call is only read when the round dispatches tools",
     L,
     "    const fromTool = captureToolSendMessage(toolUses);\n"
     "    if (fromTool !== undefined) {",
     "    const fromTool = hasTools ? captureToolSendMessage(toolUses) : undefined;\n"
     "    if (fromTool !== undefined) {"),
    ("send: the tag wins over the tool call in the same round",
     L,
     "    if (fromTool !== undefined) {",
     "    if (fromTool !== undefined && sendMessageText === undefined) {"),
    ("send: the tool-call sink is dropped entirely",
     L,
     "    const fromTool = captureToolSendMessage(toolUses);\n"
     "    if (fromTool !== undefined) {\n"
     "      sendMessageText = fromTool;\n"
     "      messageThinking = thinking;\n"
     "    }",
     "    void toolUses;"),
    ("send: the tag sink is dropped entirely",
     L,
     "    const tagged = extractSendMessage(responseText(resp));\n"
     "    if (tagged !== undefined) {\n"
     "      sendMessageText = tagged;\n"
     "      messageThinking = thinking;\n"
     "    }",
     "    void resp;"),
    ("send: `content` is ignored when a response carries no blocks",
     L,
     "  if (resp.content_blocks.length === 0) return resp.content;",
     "  if (resp.content_blocks.length === 0) return \"\";"),
    # --- the reasoning that goes with the message -----------------------------
    ("thinking: the message's reasoning never leaves the loop",
     L,
     "  return { sendMessageText, images, thinking: messageThinking, failedRound, failure };",
     "  return { sendMessageText, images, thinking: [], failedRound, failure };"),
    ("thinking: the last round's reasoning is paired with the message instead of its own",
     L,
     "    const thinking = thinkingOf(resp.content_blocks);",
     "    const thinking = thinkingOf(resp.content_blocks);\n"
     "    messageThinking = thinking;"),
    ("thinking: an image-only tick loses the reasoning that chose the image",
     L,
     "      if (round.images.length > 0 && sendMessageText === undefined) messageThinking = thinking;",
     "      void thinking;"),
    ("images: a generated image is dropped instead of riding out on the message",
     L,
     "        const ref = generatedImageRef(result.value);\n"
     "        if (ref !== undefined) images.push(ref);",
     "        void result;"),
    ("images: a failed generate_image still contributes a reference",
     L,
     "      if (!isError && name === \"generate_image\") {",
     "      if (name === \"generate_image\") {"),

    # --- the budget -----------------------------------------------------------
    ("budget: the cap ends the loop instead of buying a wrap-up window",
     L,
     "    if (action === \"break\") break;\n"
     "    if (action === \"nudge\") {",
     "    if (action === \"break\" || action === \"nudge\") break;\n"
     "    if (false as boolean) {"),
    ("budget: the grace rounds are not added, so the nudge is never answered",
     L,
     "  const totalIterations = maxNormalIterations + deps.wrapUpGrace;",
     "  const totalIterations = maxNormalIterations;"),
    ("budget: the nudge is spent again on every grace round",
     L,
     "      wrapUpNudged = true;",
     "      wrapUpNudged = false;"),
    ("budget: the nudge text is never appended, so the model is not told to wrap up",
     L,
     "      appendWrapUpNudge(request.messages);",
     "      void request;"),
    ("budget: the deadline is ignored, so a slow tick runs to the round cap",
     L,
     "      clock() >= deadline,",
     "      false,"),
    ("budget: the round cap is ignored, so only the deadline ever stops a tick",
     L,
     "      iteration >= maxNormalIterations,",
     "      false,"),
    ("budget: an absent cap is treated as zero rounds rather than unlimited",
     L,
     "  const maxNormalIterations = deps.maxToolIterations ?? Number.POSITIVE_INFINITY;",
     "  const maxNormalIterations = deps.maxToolIterations ?? 0;"),

    # --- the rounds -----------------------------------------------------------
    ("rounds: a response that does not finish on tool_use still dispatches",
     L,
     "    const hasTools = toolUses.length > 0 && resp.finish_reason === \"tool_use\";",
     "    const hasTools = toolUses.length > 0;"),
    ("rounds: the loop keeps calling after the model has finished",
     L,
     "    if (!hasTools) break;",
     "    void hasTools;"),
    ("rounds: a failed model call is treated as an empty round rather than the end",
     L,
     "    if (resp === undefined) {\n      failedRound = iteration;\n      break;\n    }",
     "    if (resp === undefined) continue;"),
    ("rounds: every call is labelled a first call, so the ledger loses the loop",
     L,
     "    const callType = iteration === 0 ? \"heartbeat\" : \"heartbeat_tool_loop\";",
     "    const callType = \"heartbeat\";"),
    ("rounds: the assistant turn is never appended, so the next round is malformed",
     L,
     "    request.messages.push({\n"
     "      role: \"assistant\",\n"
     "      content: resp.content_blocks,\n"
     "      ...(request.provider_key === undefined ? {} : { provider_key: request.provider_key }),\n"
     "      model: request.model,\n"
     "    });",
     "    void resp;"),
    ("rounds: the tool results are never appended to the request",
     L,
     "      request.messages.push({ role: \"user\", content: round.results });",
     "      void round;"),
    ("rounds: the transcript is written before dispatch, so it carries no outputs",
     L,
     "    deps.recordTranscript?.({ callType, iteration, response: resp, captured });",
     "    deps.recordTranscript?.({ callType, iteration, response: resp, captured: [] });"),

    # --- the two undeclared tools ---------------------------------------------
    ("undeclared: set_next_wake falls through to the tool registry",
     L,
     "    if (name === \"set_next_wake\") {",
     "    if (false as boolean) {"),
    ("undeclared: set_next_wake writes a second ring-buffer line",
     L,
     "    if (name !== \"set_next_wake\") deps.note(`Tool: ${name} → ${truncateSummary(output, 80)}`);",
     "    deps.note(`Tool: ${name} → ${truncateSummary(output, 80)}`);"),
    ("undeclared: set_next_wake defaults to zero hours when unspecified",
     L,
     "      const hours = typeof record[\"hours_from_now\"] === \"number\" ? record[\"hours_from_now\"] : 1;",
     "      const hours = typeof record[\"hours_from_now\"] === \"number\" ? record[\"hours_from_now\"] : 0;"),
    ("undeclared: sendMessage falls through and the model is told it is unimplemented",
     L,
     "    } else if (isSendMessageTool(name)) {",
     "    } else if (false as boolean) {"),
    ("undeclared: a tool failure is reported to the model as a success",
     L,
     "      isError = result.isError;",
     "      isError = false;"),
    ("undeclared: results come back out of order",
     L,
     "    results.push({ type: \"tool_result\", tool_use_id: id, content: output, is_error: isError });",
     "    results.unshift({ type: \"tool_result\", tool_use_id: id, content: output, is_error: isError });"),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return _run_mutants(MUTANTS, TESTS)


if __name__ == "__main__":
    sys.exit(main())
