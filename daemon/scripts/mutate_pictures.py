#!/usr/bin/env python3
"""Mutation pass over the pictures a character embeds in its messages: finding
the embeds, looking them up in the workspace, keeping the copies sent, what the
user and the model are shown, the heartbeat's retry, notifications and the web
route that serves the copies.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
EMBEDS = ROOT / "src/engine/embeds.ts"
LOOKUP = ROOT / "src/tools/message_pictures.ts"
SEND = ROOT / "src/handler/pictures.ts"
STORE = ROOT / "src/storage/sent_pictures.ts"
PERSIST = ROOT / "src/handler/persistence.ts"
PROMPT = ROOT / "src/engine/prompt.ts"
WIRE = ROOT / "src/handler/wire_messages.ts"
LOOP = ROOT / "src/autonomy/heartbeat_loop.ts"
NOTIFY = ROOT / "src/notifications.ts"
WEB = ROOT / "src/web/server.ts"
MARKDOWN = ROOT / "src/browser/markdown.tsx"
PICTURES = ROOT / "src/browser/pictures.tsx"

MUTANTS = [
    # --- finding embeds ---------------------------------------------------
    ("embeds: an escaped embed is sent", EMBEDS,
     "if (original === undefined || escaped(source, original.index, 0) || original[0] !== match[0]) continue;",
     "if (original === undefined || original[0] !== match[0]) continue;"),
    ("embeds: a size after | becomes the caption", EMBEDS,
     'label: option === undefined || option === "" || WIKILINK_SIZE.test(option) ? undefined : option,',
     'label: option === undefined || option === "" ? undefined : option,'),
    ("embeds: a remote image is looked up as a file", EMBEDS,
     'if (target === "" || REMOTE.test(target)) return undefined;',
     'if (target === "") return undefined;'),
    ("embeds: Markdown images are not embeds", EMBEDS,
     "      if (embed !== undefined) found.push(embed);",
     "      void embed;"),
    ("embeds: an unsent picture is named as if it were sent", EMBEDS,
     'result += text.slice(cursor, embed.at) + (typeof image.name === "string" && (image.problem === undefined || image.problem === null)',
     'result += text.slice(cursor, embed.at) + (typeof image.name === "string" || true'),
    ("embeds: the notice repeats a picture the tool loop carried twice", EMBEDS,
     "  const problems = [...new Set(images.flatMap(",
     "  const problems = [...(images.flatMap("),

    # --- looking pictures up ----------------------------------------------
    ("lookup: a path may leave the workspace", LOOKUP,
     "        if (!inside(root, real)) throw new Error(`${target} is outside the workspace`);\n",
     ""),
    ("lookup: a file that is not a picture is sent", LOOKUP,
     '    if (imageMime(header.subarray(0, head.bytesRead)) === undefined) throw new Error("it is not a PNG, JPEG, GIF or WebP picture");\n',
     ""),
    ("lookup: an embed that names a note is reported as a missing picture", LOOKUP,
     "      results.push(path === undefined ? null : await checked(path));",
     '      results.push(path === undefined ? { problem: "no picture" } : await checked(path));'),
    ("lookup: a Markdown path is only ever tried as a name", LOOKUP,
     "      if (!wikilink && await exists(requested)) {",
     "      if (false as boolean) {"),

    # --- sending ------------------------------------------------------------
    ("send: every picture in a message is sent, however many", SEND,
     "    const found = index < MAX_SENT_PICTURES ? lookups[index] : { problem: TOO_MANY };\n    if (found === null",
     "    const found = lookups[index] ?? lookups[0];\n    if (found === null"),
    ("send: the same embed twice is sent twice", SEND,
     "    if (seen.has(embed.source)) return false;\n",
     ""),
    ("send: the embed's own label is dropped", SEND,
     '    ...(embed.label === undefined ? {} : { caption: embed.label }),',
     ""),
    ("send: an unsent embed is dropped instead of named", SEND,
     "      images.push(unsent(embed, found.problem));\n      continue;",
     "      continue;"),
    ("send: the notification picture is the full-size original", SEND,
     "  const path = shownPicturePath(first.path);",
     "  const path = first.path;"),

    # --- keeping the copies -------------------------------------------------
    ("store: big pictures are shown to the chat at full size", STORE,
     "  if (mime === \"image/gif\" ? bytes.length <= GIF_SHOWN_AS_IS_BYTES : fits && bytes.length <= SHOWN_AS_IS_BYTES) return;",
     "  return;"),
    ("store: small pictures get a copy too", STORE,
     "  if (mime === \"image/gif\" ? bytes.length <= GIF_SHOWN_AS_IS_BYTES : fits && bytes.length <= SHOWN_AS_IS_BYTES) return;",
     "  if (mime === \"image/gif\") return;"),
    ("store: the chat copy is sized to a larger edge", STORE,
     "export const DISPLAY_EDGE = 1600;",
     "export const DISPLAY_EDGE = 2048;"),
    ("store: any file name is looked up in the sent folders", STORE,
     "  if (!SENT_PICTURE_FILE.test(file)) return undefined;\n",
     ""),
    ("store: a picture is copied once and never again, even when it changed", STORE,
     "join(dir, `${createHash(\"sha256\").update(bytes).digest(\"hex\")}.${extension}`)",
     "join(dir, `${\"0\".repeat(64)}.${extension}`)"),

    # --- replies, the model and the notice ----------------------------------
    ("persist: a reply's pictures are never sent", PERSIST,
     "  if (params.pictures !== undefined) await attachSentPictures(generatedMessages, params.pictures);",
     "  void attachSentPictures;"),
    ("persist: the notification shows the embeds as written", PERSIST,
     "  const notifyContent = pictureText(notifyContentFromResponseMessages(completedMessages), sentImages);",
     "  const notifyContent = notifyContentFromResponseMessages(completedMessages);"),
    ("persist: the notification has no picture", PERSIST,
     "    firstSentPicture(sentImages),",
     "    undefined,"),
    ("wire: embedded pictures are sent back to the model", WIRE,
     "  const images = m.images.filter((image) => image.embed === undefined);",
     "  const images = m.images;"),
    ("prompt: unsent pictures are never mentioned", PROMPT,
     "    if (pm.role === \"assistant\") unsent.push(...pm.images);",
     "    void unsent;"),
    ("prompt: the notice is lost on the next user turn", PROMPT,
     "    if (pm.role === \"user\" && !isToolLoopMessage(pm.role, pm.content_blocks)) noticed(pm);",
     "    void isToolLoopMessage;"),

    # --- the heartbeat's retry ---------------------------------------------
    ("loop: a heartbeat's pictures are never checked", LOOP,
     "    if (response !== undefined && !response.finish_reason.startsWith(\"error\")) await retryPictures(request, result, deps, run, () => clock() < deadline);",
     "    void retryPictures;"),
    ("loop: the model is not told which pictures to fix", LOOP,
     "  request.messages.push({ role: \"user\", content: [{ type: \"text\", text: pictureRetryText(problems) }] });",
     "  request.messages.push({ role: \"user\", content: [{ type: \"text\", text: pictureRetryText([]) }] });"),
    ("loop: a check that fails stops the tick", LOOP,
     "    deps.note(`Pictures could not be checked before sending: ${truncateSummary(String(error), 120)}`);\n    return;",
     "    throw error;"),

    # --- notifications ------------------------------------------------------
    ("ntfy: a refused picture loses the notification", NOTIFY,
     "    if (picture !== undefined && await ntfyAttachment(config, headers, body, picture)) return;",
     "    if (picture !== undefined) { await ntfyAttachment(config, headers, body, picture); return; }"),
    ("ntfy: headers are sent as raw UTF-8", NOTIFY,
     '  return /^[\\x20-\\x7E]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;',
     "  return text;"),

    # --- the web route ------------------------------------------------------
    ("web: anyone can load a picture", WEB,
     '        if ((sessions.read(request, true) ?? sessions.read(request, false)) === undefined) return problem(401, "unauthorized", "Sign in to see pictures");\n',
     ""),
    ("web: another site's page can load a picture", WEB,
     '        if (["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")) return problem(403, "forbidden", "Another site’s page can’t use this daemon");\n',
     ""),

    # --- the browser --------------------------------------------------------
    ("browser: wikilink embeds stay text", MARKDOWN,
     '  if (raw === undefined || !value.includes("![[")) return value;',
     "  return value;"),
    ("browser: a Markdown image embed stays a link", MARKDOWN,
     "      if (embed !== undefined) return <EmbeddedPicture key={key} embed={embed} />;",
     "      void embed;"),
    ("browser: an unsent picture shows a broken image", PICTURES,
     "  if (image === undefined || !isSentPicture(image)) {",
     "  if (image === undefined) {"),
    ("browser: pictures show when images are turned off", PICTURES,
     "  if (!pictures.shown) return",
     "  if (false as boolean) return"),
]


from mutation import run as _run_mutants


def main() -> int:
    return _run_mutants(MUTANTS, [
        "tests/embeds.test.ts",
        "tests/sent_pictures.test.ts",
        "tests/picture_delivery.test.ts",
        "tests/heartbeat_loop.test.ts",
        "tests/heartbeat_tick.test.ts",
        "tests/history_index.test.ts",
        "tests/browser_chat.test.ts",
        "tests/browser_notifications.test.ts",
    ])


if __name__ == "__main__":
    sys.exit(main())
