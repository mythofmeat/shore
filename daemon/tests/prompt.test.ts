/**
 * Recorded cases for prompt.
 *
 * These cases were captured from the deleted Rust port. That is where they
 * came from, not what makes them right: the port is gone, this side is the
 * implementation, and a case that turns out to disagree with what shore
 * should do gets corrected here rather than shimmed around. The corpus is
 * worth keeping for its inputs, which are hard to re-derive by hand.
 */

import { describe, expect, test } from "bun:test";

import {
  assemblePrompt,
  renderTemplate,
  xmlTagFromName,
  type PromptParams,
  type UserTimestampMode,
} from "../src/engine/prompt";
import type { Message, Role } from "../src/engine/types";

import fixture from "./engine_fixtures/prompt.json";

const ZONE: string = fixture.timezone;

interface AssembleCase {
  name: string;
  params: {
    character_name: string;
    display_name: string;
    system_prompt: string | null;
    tools_guidance: string | null;
    character_definition: string | null;
    user_definition: string | null;
    memory_index: string | null;
    has_prior_context: boolean;
    messages: Message[];
    max_context_tokens: number | null;
    max_output_tokens: number | null;
    user_timestamp_mode: string;
  };
  expect: {
    system: { label: string; content: string }[];
    messages: {
      role: Role;
      content: string;
      images: unknown[];
      content_blocks: unknown[];
      provider_key: string | null;
      model: string | null;
    }[];
  };
}

/** The fixture writes absent optionals as JSON null; the port takes undefined. */
const opt = (v: string | null): string | undefined => v ?? undefined;
const optNum = (v: number | null): number | undefined => v ?? undefined;

function paramsOf(c: AssembleCase): PromptParams {
  const p = c.params;
  return {
    character_name: p.character_name,
    display_name: p.display_name,
    system_prompt: opt(p.system_prompt),
    tools_guidance: opt(p.tools_guidance),
    character_definition: opt(p.character_definition),
    user_definition: opt(p.user_definition),
    memory_index: opt(p.memory_index),
    has_prior_context: p.has_prior_context,
    // Rust's `Message` omits empty/absent fields on the wire; the port's
    // `Message` wants the arrays present, exactly as `normalize()` leaves them.
    messages: p.messages.map((m) => ({
      ...m,
      images: m.images ?? [],
      content_blocks: m.content_blocks ?? [],
    })),
    max_context_tokens: optNum(p.max_context_tokens),
    max_output_tokens: optNum(p.max_output_tokens),
    user_timestamp_mode: p.user_timestamp_mode as UserTimestampMode,
  };
}

describe("prompt parity: assemble_prompt", () => {
  const cases = fixture.assemble_prompt as unknown as AssembleCase[];

  test("the fixture is the one that was generated", () => {
    expect(cases.length).toBe(44);
    expect(ZONE).toBe("America/New_York");
  });

  for (const c of cases) {
    const kept = KEPT_UNDER_CORRECTED_ESTIMATOR.get(c.name);
    const label = kept === undefined ? c.name : `${c.name} (diverges: #89)`;
    test(label, () => {
      const got = assemblePrompt(paramsOf(c), ZONE);

      expect(got.system).toEqual(c.expect.system);

      if (kept !== undefined) {
        expect(got.messages.length).toBe(kept);
        expect(got.messages.map((m) => m.role)).toEqual(
          c.expect.messages.slice(c.expect.messages.length - kept).map((m) => m.role),
        );
        return;
      }

      expect(got.messages.length).toBe(c.expect.messages.length);

      c.expect.messages.forEach((want, i) => {
        const have = got.messages[i]!;
        expect(have.role).toBe(want.role);
        expect(have.content).toBe(want.content);
        expect(have.content_blocks).toEqual(want.content_blocks as never);
        expect(have.images).toEqual(want.images as never);
        expect(have.provider_key ?? null).toBe(want.provider_key);
        expect(have.model ?? null).toBe(want.model);
      });
    });
  }
});

/**
 * The two cases whose answer changed with #89, and by how much.
 *
 * The Rust estimated a token at four UTF-8 bytes. Measured against what
 * Anthropic actually billed on captured requests the true figure is near
 * three, so the Rust's budget was about 30% too generous and both of these
 * cases kept one message more than fits. The fixture still records what the
 * Rust answered — it is frozen and this is a deliberate divergence, not drift
 * — so the corrected count is pinned here instead, alongside the rule that
 * trimming always drops from the front.
 */
const KEPT_UNDER_CORRECTED_ESTIMATOR = new Map<string, number>([
  ["budget_drops_oldest", 2],
  ["multibyte_counts_utf8_bytes_not_chars", 1],
]);

describe("prompt parity: xml_tag_from_name", () => {
  for (const c of fixture.xml_tag_from_name as {
    input: string;
    fallback: string;
    expect: string;
  }[]) {
    test(`${JSON.stringify(c.input)} -> ${c.expect}`, () => {
      expect(xmlTagFromName(c.input, c.fallback)).toBe(c.expect);
    });
  }
});

describe("prompt parity: render_template", () => {
  for (const c of fixture.render_template as {
    template: string;
    vars: Record<string, string>;
    expect: string;
  }[]) {
    test(JSON.stringify(c.template), () => {
      expect(renderTemplate(c.template, new Map(Object.entries(c.vars)))).toBe(c.expect);
    });
  }
});

describe("render_template: the one deliberate divergence", () => {
  // The Rust substituted by iterating a HashMap, so a value containing another
  // key's tag was re-scanned or not depending on an unspecified, per-map
  // reseeded order — `{a: "{{b}}", b: "B"}` rendered "{{a}}" as either "B" or
  // "{{b}}" across runs. That is a nondeterministic cache prefix. The port does
  // one pass and never re-scans, so it always produces the second reading.
  test("a substituted value is never re-scanned", () => {
    const vars = new Map([
      ["a", "{{b}}"],
      ["b", "B-VALUE"],
    ]);
    expect(renderTemplate("[{{a}}]", vars)).toBe("[{{b}}]");
  });

  test("and it is stable across repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(
        renderTemplate(
          "[{{a}}]",
          new Map([
            ["a", "{{b}}"],
            ["b", "B-VALUE"],
          ]),
        ),
      );
    }
    expect([...seen]).toEqual(["[{{b}}]"]);
  });

  test("a character named {{user}} renders one system prompt, not two", () => {
    const base: PromptParams = {
      character_name: "{{user}}",
      display_name: "Dana",
      system_prompt: "I am {{char}} talking to {{user}}.",
      has_prior_context: false,
      messages: [],
      user_timestamp_mode: "never",
    };
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(assemblePrompt(base, ZONE).system[0]!.content);
    }
    expect([...seen]).toEqual(["I am {{user}} talking to Dana."]);
  });
});

describe("timezone is a parameter, not the host's", () => {
  const at = (ts: string, zone: string): string =>
    assemblePrompt(
      {
        character_name: "Ada",
        display_name: "Dana",
        has_prior_context: true,
        messages: [
          {
            msg_id: "m1",
            role: "user",
            content: "hi",
            images: [],
            content_blocks: [{ type: "text", text: "hi" }],
            timestamp: ts,
          },
        ],
        user_timestamp_mode: "always",
      },
      zone,
    ).messages[0]!.content;

  test("the same instant reads differently in two zones", () => {
    const instant = "2026-04-04T12:00:00+00:00";
    expect(at(instant, "America/New_York")).toStartWith("[Saturday 2026-04-04 · 8:00 AM]");
    // Sydney is still on DST here: it ends the first Sunday in April, the 5th.
    expect(at(instant, "Australia/Sydney")).toStartWith("[Saturday 2026-04-04 · 11:00 PM]");
    expect(at(instant, "UTC")).toStartWith("[Saturday 2026-04-04 · 12:00 PM]");
  });

  test("a timestamp with no offset is unparseable, as chrono has it", () => {
    // Date.parse would read this as host-local and silently move the marker.
    expect(at("2026-04-04T12:00:00", "UTC")).toBe("hi");
    expect(at("2026-04-04", "UTC")).toBe("hi");
  });
});
