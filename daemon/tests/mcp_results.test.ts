import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { interpretResult, McpClient, McpError } from "../src/mcp/client.ts";
import { MCP_TEXTS } from "../src/texts/registry.ts";
import { Texts } from "../src/texts/texts.ts";
import { toolMediaOf } from "../src/tools/media.ts";
import { rejectionOf } from "./support/outcome.ts";

const shipped = new Texts();

function marked(): Texts {
  return Texts.from(Object.fromEntries(MCP_TEXTS.map((spec) => [spec.name, `⟦${spec.name}${Object.keys(spec.values).map((value) => `{{#if ${value}}}|${value}={{${value}}}{{/if}}`).join("")}⟧`])));
}

const EVERY_KIND = {
  content: [
    { type: "text", text: "said" },
    { type: "audio", data: "AAAA", mimeType: "Audio/WAV" },
    { type: "audio" },
    { type: "image", data: "AAAA", mimeType: "image/bmp" },
    { type: "image", data: "AAAA" },
    { type: "image", mimeType: "image/png" },
    { type: "image", data: "AAAA", mimeType: "IMAGE/PNG" },
    { type: "resource", resource: { uri: "file:///notes.txt", text: "the {{notes}}" } },
    { type: "resource", resource: { text: "nameless" } },
    { type: "resource", uri: "file:///flat.txt", text: "flat" },
    { type: "resource", resource: { uri: "file:///song.ogg", blob: "A".repeat(2000), mimeType: "audio/ogg" } },
    { type: "resource", resource: { blob: "AAAA" } },
    { type: "resource", resource: { uri: "file:///map.png", blob: "AAAA", mimeType: "image/png" } },
    { type: "resource", resource: { blob: "AAAA", mimeType: "image/webp" } },
    { type: "resource", resource: { uri: "file:///nothing" } },
    { type: "resource", resource: {} },
    { type: "resource_link", uri: "file:///map.png", name: "map", mimeType: "image/png" },
    { type: "resource_link" },
    { type: "hologram" },
    { kind: "nothing" },
    "not a block",
    null,
  ],
};

describe("what Shore makes of an MCP tool's result", () => {
  test("words each kind of content it can't pass on, in Shore's wording", () => {
    const payload = interpretResult(shipped, EVERY_KIND);
    expect(payload.value).toBe("said");
    expect(payload.extra).toEqual([
      "[audio omitted: audio/wav, 3 bytes — shore cannot send audio to a model]",
      "[audio omitted: the server sent no audio data]",
      "[image omitted: image/bmp is not a supported format]",
      "[image omitted: an unlabelled type is not a supported format]",
      "[image omitted: the server sent no image data]",
      "[resource file:///notes.txt]\nthe {{notes}}",
      "[resource an unnamed resource]\nnameless",
      "[resource file:///flat.txt]\nflat",
      "[resource file:///song.ogg omitted: audio/ogg, 1.5 KB — shore cannot render it]",
      "[resource an unnamed resource omitted: an unlabelled type, 3 bytes — shore cannot render it]",
      "[resource file:///nothing omitted: it carried no text or data]",
      "[resource an unnamed resource omitted: it carried no text or data]",
      "[resource link: map: file:///map.png (image/png)]",
      "[resource link: an unnamed resource]",
      "[hologram content omitted: shore cannot render it]",
      "[unlabelled content omitted: shore cannot render it]",
    ]);
    expect(payload.media.map((item) => [item.mime_type, item.label])).toEqual([["image/png", "image/png, 3 bytes"], ["image/png", "file:///map.png (image/png, 3 bytes)"], ["image/webp", "(image/webp, 3 bytes)"]]);
  });

  test("words them in the user's wording with the values each is given, and leaves out what is switched off", () => {
    expect(interpretResult(marked(), EVERY_KIND).extra.slice(0, 3)).toEqual(["⟦mcp_audio|type=audio/wav|size=3 bytes⟧", "⟦mcp_no_audio⟧", "⟦mcp_image_type|type=image/bmp⟧"]);
    expect(interpretResult(marked(), EVERY_KIND).extra.slice(5)).toEqual([
      "⟦mcp_resource|uri=file:///notes.txt|text=the {{notes}}⟧", "⟦mcp_resource|text=nameless⟧", "⟦mcp_resource|uri=file:///flat.txt|text=flat⟧",
      "⟦mcp_resource_binary|uri=file:///song.ogg|type=audio/ogg|size=1.5 KB⟧", "⟦mcp_resource_binary|size=3 bytes⟧",
      "⟦mcp_resource_empty|uri=file:///nothing⟧", "⟦mcp_resource_empty⟧",
      "⟦mcp_resource_link|name=map|uri=file:///map.png|type=image/png⟧", "⟦mcp_resource_link⟧", "⟦mcp_unknown|type=hologram⟧", "⟦mcp_unknown⟧",
    ]);
    const off = Texts.from(Object.fromEntries(MCP_TEXTS.map((spec) => [spec.name, null])));
    expect(interpretResult(off, EVERY_KIND).extra).toEqual([]);
  });

  test("structured content is the value, and text that only repeats it is dropped", () => {
    const payload = interpretResult(shipped, { structuredContent: { a: 1 }, content: [{ type: "text", text: "{\"a\":1}" }, { type: "text", text: "also" }, { type: "text", text: "{not json" }, { type: "audio" }] });
    expect(payload.value).toEqual({ a: 1 });
    expect(payload.extra).toEqual(["also", "{not json", "[audio omitted: the server sent no audio data]"]);
    expect(interpretResult(shipped, {}).value).toBe("");
  });

  test("sizes are told in bytes, kilobytes or megabytes", () => {
    const sized = (chars: number) => interpretResult(shipped, { content: [{ type: "audio", data: "A".repeat(chars), mimeType: "audio/wav" }] }).extra[0];
    expect(sized(1364)).toBe("[audio omitted: audio/wav, 1023 bytes — shore cannot send audio to a model]");
    expect(sized(1368)).toBe("[audio omitted: audio/wav, 1.0 KB — shore cannot send audio to a model]");
    expect(sized(1_398_104)).toBe("[audio omitted: audio/wav, 1.0 MB — shore cannot send audio to a model]");
  });
});

describe("calling a tool on an MCP server", () => {
  let client: McpClient;
  beforeAll(async () => {
    client = await McpClient.connect({ name: "fixture", transport: { kind: "stdio", command: process.execPath, args: ["run", join(import.meta.dir, "support/mcp_tool_fixture.ts")], env: {} } });
  });
  afterAll(async () => { await client.shutdown(); });

  test("answers with what the server sent and notes in the character's wording, and an error result as an error carrying the same", async () => {
    const answer = toolMediaOf(await client.call("every_kind", {}, marked()));
    expect(answer?.value).toBe("said");
    expect(answer?.extra).toEqual([
      "⟦mcp_audio|type=audio/wav|size=3 bytes⟧", "⟦mcp_image_type|type=image/bmp⟧", "⟦mcp_resource|uri=file:///notes.txt|text=the notes⟧",
      "⟦mcp_resource_binary|uri=file:///song.ogg|type=audio/ogg|size=3 bytes⟧", "⟦mcp_resource_link|name=map|uri=file:///map.png|type=image/png⟧",
    ]);
    const failure = await rejectionOf(client.call("fails", {}, marked()));
    expect(failure).toBeInstanceOf(McpError);
    expect((failure as Error).message).toBe("MCP tool 'fails' returned an error: it broke\n⟦mcp_audio|type=audio/wav|size=3 bytes⟧");
  });

  test("arguments that aren't an object are refused before anything is sent, and none at all are fine", async () => {
    expect(String(await rejectionOf(client.call("every_kind", [1], shipped)))).toContain("invalid arguments for MCP tool 'every_kind': expected a JSON object, got [1]");
    expect(toolMediaOf(await client.call("every_kind", undefined, shipped))?.value).toBe("said");
    expect(toolMediaOf(await client.call("every_kind", null, shipped))?.value).toBe("said");
  });
});
