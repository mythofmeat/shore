import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outcomeOf } from "./support/outcome.ts";

describe("the command sink spawns argv directly", () => {
  test("hostile content reaches the process as argv, unexecuted", async () => {
    const { realSink } = await import("../src/notifications.ts");
    const dir = await mkdtemp(join(tmpdir(), "shore-notify-"));
    const pwned = join(dir, "pwned");
    const hostile = `; touch ${pwned} & echo $(id) \`whoami\` > ${pwned}`;
    const marker = join(dir, "argv.json");
    const probe = join(dir, "probe.ts");
    await Bun.write(
      probe,
      `await Bun.write(${JSON.stringify(marker)}, JSON.stringify(Bun.argv.slice(2)))\n`,
    );
    await realSink.command(["bun", probe, "{title}", "{body}"], "T", hostile);
    expect(await Bun.file(marker).json()).toEqual(["T", hostile]);
    expect(await Bun.file(pwned).exists()).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  test("an empty command is refused before anything is spawned", async () => {
    const { realSink } = await import("../src/notifications.ts");
    expect(await outcomeOf(realSink.command([], "t", "b"))).toThrow("notification command is not configured");
  });

  test("a non-zero exit is surfaced, not swallowed", async () => {
    const { realSink } = await import("../src/notifications.ts");
    expect(await outcomeOf(realSink.command(["false"], "t", "b"))).toThrow("exited 1");
  });
});
