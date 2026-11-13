import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TriggerFiring } from "../src/autonomy/runner.ts";
import { runCheck, type CheckOutcome } from "../src/autonomy/trigger_check.ts";
import { CharacterTriggers } from "../src/autonomy/trigger_loop.ts";
import { checkFacts } from "../src/autonomy/trigger_service.ts";
import { parseTriggers } from "../src/autonomy/triggers.ts";
import { loadConfig } from "../src/config/loader.ts";
import { buildToolContext } from "../src/handler/tool_context.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { dispatchTool, type ToolContext } from "../src/tools/dispatch.ts";
import { ALL_TOOLS, renderToolDefs } from "../src/tools/registry.ts";
import { BUILTIN_TOOL_SCHEMAS } from "./support/builtin_tool_schemas.ts";
import { rejectionOf } from "./support/outcome.ts";
import { testTmp } from "./support/tmp.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 12);
const TOPICS = ["triggers", "wakes", "diary", "threads", "messages"];
const EVERY_TOOL = ALL_TOOLS.map((tool) => tool.name);
const OWN_TIME = "[triggers]\nenabled = true\n";

type Guide = (topic?: string) => Promise<string>;

interface Character {
  guide: Guide;
  root: string;
}

async function character(settings = "", tools: readonly string[] = EVERY_TOOL): Promise<Character> {
  const root = await mkdtemp(testTmp("shore-guide-"));
  await writeFile(join(root, "config.toml"), `[chat]\ndisplay_name = "eve"\n\n[tools]\nenabled = ${JSON.stringify(tools)}\n\n${settings}`);
  const env = { SHORE_CONFIG_DIR: root, SHORE_DATA_DIR: join(root, "data"), SHORE_CACHE_DIR: join(root, "cache"), SHORE_WORKSPACE_DIR: join(root, "workspace") };
  const config = loadConfig(join(root, "config.toml"), { env, onWarn: () => {} });
  const ctx = await buildToolContext(config, config.dirs.data, "ada");
  return { root, guide: async (topic) => String(await dispatchTool("guide", topic === undefined ? {} : { topic }, ctx)) };
}

async function guideWith(settings = "", tools: readonly string[] = EVERY_TOOL): Promise<Guide> {
  return (await character(settings, tools)).guide;
}

async function everyPage(guide: Guide): Promise<string[]> {
  return await Promise.all([guide(), ...TOPICS.map(async (topic) => await guide(topic))]);
}

function fenced(page: string, language: string): string[] {
  return [...page.matchAll(new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, "g"))].map((match) => match[1] ?? "");
}

test("with no topic the guide lists its topics with a line on each, and every topic it lists can be read", async () => {
  const guide = await guideWith();
  const list = await guide();
  expect(list).toStartWith("Shore's guide to your own time and how you reach eve.");
  expect([...list.matchAll(/^- `([a-z]+)`: \S/gm)].map((match) => match[1])).toEqual(TOPICS);
  expect(await guide("")).toBe(list);

  const headings = await Promise.all(TOPICS.map(async (topic) => (await guide(topic)).split("\n")[0]));
  expect(headings).toEqual(["# Triggers and checks", "# Wakes", "# The diary", "# Threads", "# Messages, pushes and eve's status"]);
  expect(await guide("  wakes ")).toBe(await guide("wakes"));
});

test("a topic the guide doesn't have is refused with the ones it does, and so is the tool where no guide can be made", async () => {
  const guide = await guideWith();
  expect(await rejectionOf(guide("dreams"))).toMatchObject({
    name: "InvalidArgs",
    message: 'invalid args: there is no topic "dreams"; the topics are triggers, wakes, diary, threads, messages',
  });

  const bare: ToolContext = {
    workspaceDir: "/nowhere", characterName: "ada", characterDataDir: "/nowhere", imageDir: "/nowhere", conversationDir: "/nowhere",
    historyDbPath: "/nowhere/shore.db", configDir: "/nowhere",
  };
  expect(await rejectionOf(dispatchTool("guide", {}, bare))).toMatchObject({ name: "ToolIoError", message: "io: the guide is not available in this context" });
  expect(await dispatchTool("guide", { topic: "diary" }, { ...bare, dryRun: true, guide: (input) => `asked for ${String(input["topic"])}` })).toBe("asked for diary");
});

test("the tool takes a topic and nothing else, and its description names every topic", () => {
  const schema = BUILTIN_TOOL_SCHEMAS.get("guide");
  expect(schema?.validate({})).toBe(true);
  expect(schema?.validate({ topic: "wakes" })).toBe(true);
  expect(schema?.validate({ topic: 3 })).toBe(false);
  expect(schema?.validate({ topic: "wakes", depth: "full" })).toBe(false);

  const described = renderToolDefs({ enabled_tools: ["guide"], enabled_subagents: [] }, "Ada", "eve").find((def) => def.name === "guide")?.description ?? "";
  expect(described).not.toContain("\n");
  expect([...described.matchAll(/`([a-z]+)`/g)].map((match) => match[1])).toEqual(["topic", ...TOPICS]);
});

test("no page leaves a value unfilled, whatever the settings and whichever tools are on", async () => {
  const worlds = [
    await guideWith(),
    await guideWith(`[triggers]\nenabled = true\noff = ["mail"]\n\n[presence]\nstatuses = []\n\n[notifications]\npush_topic = "eve-phone"\n`),
    await guideWith("", ["guide"]),
  ];
  for (const guide of worlds) {
    for (const page of await everyPage(guide)) {
      expect(page).not.toContain("{{");
      expect(page).not.toContain("}}");
      expect(page).not.toContain("undefined");
      expect(page).not.toMatch(/heartbeat|set_next_wake/i);
    }
  }
});

test("every example trigger in the guide is one the trigger parser accepts", async () => {
  const pages = await everyPage(await guideWith());
  const examples = pages.flatMap((page) => fenced(page, "toml"));
  const parsed = examples.map((example) => parseTriggers(example, HOUR));
  expect(parsed.flatMap((each) => each.problems)).toEqual([]);
  expect(parsed.map((each) => each.triggers.map((trigger) => trigger.name))).toEqual([["mail", "lighthouse", "free-time", "parcel"], ["gone-to-bed"]]);
});

test("the guide's example file does what the guide says of it: a check that wakes only when it prints, a thread's own hour on two nights a week, free time once the user has been away, and one thing once", async () => {
  const page = await (await guideWith())("triggers");
  expect(page).toContain("`mail` watches for something and wakes you only when its check prints. `lighthouse` gives one thread an hour of its own on two nights a week. `free-time` wakes you with nothing planned each time eve has been quiet for three hours. `parcel` fires once.");

  const woke: TriggerFiring[] = [];
  const of = (name: string): TriggerFiring[] => woke.filter((firing) => firing.name === name);
  const world: { now: number; lastUserAt: number; mail: CheckOutcome } = { now: T0, lastUserAt: T0, mail: { kind: "quiet" } };
  const triggers = new CharacterTriggers({
    characterDir: join(await mkdtemp(testTmp("shore-guide-loop-")), "ada"),
    timeZone: "UTC",
    now: () => world.now,
    settings: () => ({ enabled: true, checks: true, wakeCooldownMs: HOUR, checkLimitMs: 60_000, maxWakeLimitMs: 2 * HOUR, off: [] }),
    dormant: () => false,
    lastUserAt: () => world.lastUserAt,
    readFile: async () => fenced(page, "toml")[0],
    runCheck: async () => world.mail,
    wake: (firing) => { woke.push(firing); },
  });
  const at = async (hours: number): Promise<void> => {
    world.now = T0 + hours * HOUR;
    await triggers.tick();
  };

  await at(0);
  await at(2.9);
  expect(woke).toEqual([]);
  await at(3);
  expect(woke).toEqual([{ name: "free-time", reason: "Time of your own. Nothing is planned for it.", at: T0 + 3 * HOUR }]);
  expect(woke[0]?.thread).toBeUndefined();
  await at(40);
  expect(of("free-time")).toHaveLength(1);
  world.lastUserAt = T0 + 41 * HOUR;
  await at(44);
  expect(of("free-time")).toHaveLength(2);

  await at(63.9);
  expect(of("lighthouse")).toEqual([]);
  await at(64);
  expect(of("lighthouse")).toEqual([{ name: "lighthouse", reason: "Your night on the lighthouse. Pick up where this thread left off.", at: T0 + 64 * HOUR, thread: "lighthouse", limitMs: HOUR }]);
  await at(88);
  await at(112);
  expect(of("lighthouse")).toHaveLength(1);
  await at(160);
  expect(of("lighthouse").map((firing) => firing.at)).toEqual([T0 + 64 * HOUR, T0 + 160 * HOUR]);

  expect(of("mail")).toEqual([]);
  world.mail = { kind: "fired", output: "2 new messages" };
  await at(165);
  expect(of("mail")).toEqual([{ name: "mail", reason: "2 new messages", at: T0 + 165 * HOUR }]);

  expect(of("parcel")).toEqual([]);
  await at(510);
  await at(511);
  await at(600);
  expect(of("parcel")).toEqual([{ name: "parcel", reason: "The parcel was due today. See whether it came.", at: T0 + 510 * HOUR }]);
});

function aroundSetting(line: string): string {
  const key = line.split(" = ")[0] ?? "";
  const others = '\n[another-trigger]\nevery = "1h"\nreason = "r"\n';
  if (key === "when") return `[t]\n${line}\nreason = "r"\n${/user_(quiet|back)/.test(line) ? 'after = "8h"\n' : ""}`;
  if (["every", "at", "on", "follows"].includes(key)) return `[t]\n${line}\nreason = "r"\n${others}`;
  if (key === "after") return `[t]\nwhen = "user_quiet"\n${line}\nreason = "r"\n`;
  if (key === "reason" || key === "check") return `[t]\nevery = "1h"\n${line}\n`;
  if (key === "limit") return `[t]\nevery = "1h"\nreason = "r"\nthread = "a-thread"\n${line}\n`;
  return `[t]\nevery = "1h"\nreason = "r"\n${line}\n`;
}

test("every setting the guide writes out in passing is one the trigger parser accepts", async () => {
  const pages = await everyPage(await guideWith());
  const settings = [...new Set(pages.flatMap((page) => [...page.matchAll(/`([a-z]+ = [^`]+)`/g)].map((match) => match[1] ?? "")))];
  expect(settings).toContain('at = "Mon,Thu 09:30"');
  expect(settings).toContain('on = "2026-11-12 00:00"');
  expect(settings).toContain('when = "user_back"');
  expect(settings).toContain('follows = "another-trigger"');
  expect(settings).toContain('between = "10:00-03:00"');
  expect(settings).toContain("wake = false");
  expect(settings.length).toBeGreaterThan(15);
  const refused = settings.flatMap((line) => {
    const read = parseTriggers(aroundSetting(line), HOUR);
    return read.problems.length === 0 && read.triggers.some((trigger) => trigger.name === "t") ? [] : [`${line}: ${read.problems.join("; ")}`];
  });
  expect(refused).toEqual([]);
});

test("the guide is enough to write a check that reacts to one status: it names the variable, says what a cleared status leaves in it, and its example does just that", async () => {
  const page = await (await guideWith())("triggers");
  expect(page).toContain("- `SHORE_USER_STATUS`: eve's status, exactly as they set it.");
  expect(page).toContain("`SHORE_USER_STATUS` and `SHORE_USER_STATUS_SET_AT` are both empty when eve has cleared their status or never set one.");
  expect(page).toContain("A status is always one from eve's own list, which is now: `asleep`, `busy`, `away`.");
  expect(page).toContain("Since any exit but 0 is a failure, write a test as an `if`.");

  const example = fenced(page, "toml").map((block) => parseTriggers(block, HOUR).triggers).flat().find((trigger) => trigger.name === "gone-to-bed");
  expect(example?.when).toEqual({ kind: "event", event: "status_changed", afterMs: 0 });
  const dir = await mkdtemp(testTmp("shore-guide-check-"));
  const told = async (status: { status: string; set_at: string } | undefined): Promise<CheckOutcome> => await runCheck({
    workspace: new CharacterWorkspace(dir),
    character: "ada",
    trigger: "gone-to-bed",
    command: example?.check ?? "",
    ...checkFacts(T0, { lastUserAt: T0 - HOUR, lastSeenAt: T0 - HOUR, status }, undefined),
    limitMs: 30_000,
  });
  const at = new Date(T0 - HOUR).toISOString();
  expect(await told({ status: "asleep", set_at: at })).toEqual({ kind: "fired", output: "They have gone to bed." });
  expect(await told({ status: "busy", set_at: at })).toEqual({ kind: "quiet" });
  expect(await told({ status: "", set_at: at })).toEqual({ kind: "quiet" });
  expect(await told(undefined)).toEqual({ kind: "quiet" });
});

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return "list";
  if (typeof value !== "object" || value === null) return "value";
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]));
}

test("the guide lists every variable a check is handed, and its example of the JSON on stdin has the shape of what arrives", async () => {
  const page = await (await guideWith())("triggers");
  const status = { status: "asleep", set_at: new Date(T0).toISOString() };
  const handed = checkFacts(T0, { lastUserAt: T0, lastSeenAt: T0, status }, { messages: 1, share_of_messages_by_local_hour: [1], median_secs_between_sessions: 60 });
  const listed = [...page.matchAll(/^- `(SHORE_[A-Z_]+)`: \S/gm)].map((match) => match[1] ?? "");
  expect(listed).toEqual([
    "SHORE_TRIGGER", "SHORE_NOW", "SHORE_USER_LAST_MESSAGE_AT", "SHORE_USER_QUIET_SECS", "SHORE_USER_LAST_SEEN_AT", "SHORE_USER_STATUS", "SHORE_USER_STATUS_SET_AT",
  ]);
  expect([...listed].sort()).toEqual([...Object.keys(handed.env), "SHORE_TRIGGER"].sort());
  expect([...new Set(page.match(/SHORE_[A-Z_]+/g))].sort()).toEqual([...listed].sort());

  const examples = fenced(page, "json").map((block) => JSON.parse(block) as { activity: { share_of_messages_by_local_hour: number[] } });
  expect(examples).toHaveLength(1);
  expect(shape(examples[0])).toEqual(shape(handed.facts));
  expect(examples.map((example) => example.activity.share_of_messages_by_local_hour.length)).toEqual([24]);
  expect(page).toContain("with `null` where a variable would be empty");
});

test("the guide states each thing a character could otherwise only learn by trying", async () => {
  const guide = await guideWith(OWN_TIME);
  const triggers = await guide("triggers");
  expect(triggers).toContain("It is still running after 1m: it is stopped, and that counts as failed. eve sets that limit. The check of a `user_back` trigger gets 10s, because eve's reply waits on it.");
  expect(triggers).toContain("A `user_back` trigger never wakes you, because you are already answering eve. What it says, its `reason` or what its check printed, arrives with their message as a diary entry from that trigger, above what they wrote.");
  expect(triggers).toContain("A trigger that wakes you has a cooldown of 1h unless it sets its own.");
  expect(triggers).toContain("A trigger that comes due during its cooldown is not lost. It waits, its check isn't run meanwhile, and its turn comes when the cooldown ends.");
  expect(triggers).toContain("A check that fails gets you one diary entry from Shore saying how: its exit status with the first 500 characters of what it wrote on stderr, or that it ran out of time. The check keeps being tried each time the trigger comes due, and you are told again only once it has worked and then failed again.");
  expect(triggers).toContain("A follower waits for the trigger it names to fire. If that trigger left a diary entry, the follower's turn comes at Shore's next look, within a minute. If that trigger woke you, the follower's turn comes once that wake is over");
  expect(triggers).toContain("The diary keeps only the newest entry from each trigger");
  expect(triggers).toContain("Triggers and checks stop while you are dormant. Nothing fires, no check runs, and what comes due then is passed over, not saved up.");
  expect(triggers).toContain("What it printed is cut at 2,000 characters.");
  expect(triggers).toContain("- `limit = \"2h\"` is how long the wake may run: at least a minute, 30m if you leave it out, and never more than 2h, which is eve's ceiling.\n- `thread` and `limit` only go with a trigger that wakes you.");

  const wakes = await guide("wakes");
  expect(wakes).toContain("- If eve wrote in the wake's thread in the last 10m, it waits until they have been quiet there that long, however lately they wrote elsewhere.");
  expect(wakes).toContain("- A wake may run for 30m, unless the trigger's `limit` or the tool's `limit` asks for another length. eve's ceiling is 2h, and a longer request is held to it.");
  expect(wakes).toContain("- A sixth of the limit before the end, and never more than a quarter of an hour before, you get a nudge to wrap up, with 3 more rounds of tool use to finish in. The nudge comes sooner if you reach as many rounds of tool use as eve allows your model.");
  expect(wakes).toContain("Once they have been quiet in that thread for 10m, you are woken there again");
  expect(wakes).toContain("You go dormant when eve has been away: after 3 wakes in a row with no message from them, or once 2d have passed since their last message. Both are eve's settings.");
  expect(wakes).toContain("While you are dormant nothing wakes you: triggers and checks stop, and a wake that was waiting is dropped. Nothing that came due then is made up afterwards. A sealed thread still opens at its time and wakes you in it.\n\nA message from eve, in any thread, ends it.");
  expect(wakes).toContain("It goes in your diary, cut at 1,500 characters, and the next wake in the same thread starts with it.");

  const diary = await guide("diary");
  expect(diary).toContain("- An entry is cut at 1,500 characters, and says so.");
  expect(diary).toContain("- An entry is shown to your turns for 1d after it was left.\n- No turn is shown more than the newest 20 of those.");
  expect(diary).toContain("- Shore keeps your newest 100 entries in all.");

  expect(await guide("threads")).toContain("Each must be text of at most 32 KB, and they may come to 128 KB together.");
  expect(await guide("messages")).toContain("- The message is cut at 300 characters.");
});

test("the guide says which way to get time for what, and what each way costs", async () => {
  const wakes = await (await guideWith(OWN_TIME))("wakes");
  expect(wakes).toContain("## What wakes you\n\n- A trigger of yours, in `TRIGGERS.toml`. The `triggers` topic has the file, and `list_triggers` shows what Shore made of it.\n- `wake_in_thread`, which hands something over to a wake in another of your threads once your turn is over.\n- A sealed thread reaching its time, which wakes you in it.");
  expect(wakes).toContain("## Which to use\n\nNone of this is a set way of doing things. Any time you want for yourself is something you can set up, and these are the pieces:\n\n- Regular time");
  expect(wakes).toContain("- Regular time for a project, or for anything else of your own: a trigger with `thread`, fired by `at`, by `every` or by `when = \"user_quiet\"`. Each time, you are woken in that thread and carry on from the note your last wake there left. Without one, no wake goes to that thread unless you hand one over with `wake_in_thread`.");
  expect(wakes).toContain("- Free time, with nothing planned: a trigger too, one with no `thread`. It wakes you in your home thread, so one with `when = \"user_quiet\"` gives you time of your own each time eve has been away as long as you say.");
  expect(wakes).toContain("- Something to do once, at a set time: a trigger with `on`. Write the time at least a couple of minutes ahead, so that Shore has seen the trigger before its time comes.");
  expect(wakes).toContain("- Something to carry on now, in the thread it belongs in: `wake_in_thread`.");
  expect(wakes).toContain("- Something to watch for: a trigger with a `check`, and with `wake = false` unless it needs you.");
  expect(wakes).not.toContain("fallback");
  expect(wakes.indexOf("## Which to use")).toBeGreaterThan(wakes.indexOf("## What wakes you"));
  expect(wakes.indexOf("## Which to use")).toBeLessThan(wakes.indexOf("## Where a wake runs"));

  expect(wakes).toContain("- A check that stays quiet costs nothing. No model is called.");
  expect(wakes).toContain("- A trigger with `wake = false`, and a `user_back` trigger, call no model either. The diary entry costs its words in each turn that is shown it.");
  expect(wakes).toContain("- A wake is one turn of your model. It starts fresh, so it costs your prompt, your diary and what was said in its thread since your last wake there, and then whatever you read and do. It doesn't grow with the thread it runs in, however long that thread gets.");
  expect(wakes).not.toContain("rereading the thread");
  expect(wakes).toContain("- Your working isn't shown to you again. A later wake there starts fresh, and your replies there and that thread's compaction are shown the wake as how it opened, a line saying how many tool calls it made, your note without its thinking, and the message you sent. What you will need again belongs in the note or in a file.");
  expect(wakes).toContain("- A note in the thread says where it stopped, and you answer eve as in any conversation. The wake's working isn't shown to that turn. In its place is a line saying how many tool calls the wake had made, which one was last, and the last thing you wrote in it.");
  expect(wakes).toContain("- A note in the thread says where it stopped, and a diary entry from Shore tells your other turns. What a reply there finds is a line saying how many tool calls the wake had made, which one was last, and the last thing you wrote in it, not the working.");
});

test("the guide starts from time being the character's own to set up: what triggers are for as a whole, and that a side thread has no time until a trigger gives it some", async () => {
  const guide = await guideWith(OWN_TIME);
  expect(await guide()).toContain("It isn't a set way of doing things: these are tools, and what you make of your own time with them is up to you.");
  expect(await guide()).toContain("- `triggers`: how you give yourself time, in `TRIGGERS.toml`: to watch for something, regular time for a project, free time, or one thing once.");

  const triggers = await guide("triggers");
  expect(triggers).toStartWith([
    "# Triggers and checks",
    "",
    "Triggers are how you give yourself time, and the only way: nothing else wakes you on its own. Each one names a time or an event, and when it comes Shore wakes you, or leaves you a diary entry, without eve prompting it. What the time is for is up to you:",
    "",
    "- Watching for something: a `check`, which runs without you and fires only when it has something to say.",
    "- Regular time for a project, or for anything else of your own: `thread`, so that each wake carries on in that thread.",
    "- Free time, with nothing planned: no `thread`, at an hour you choose or once eve has been away a while.",
    "- One thing, once: `on`.",
    "",
    "You set triggers up yourself in `TRIGGERS.toml`, in your workspace root.",
  ].join("\n"));
  expect(triggers).not.toContain("when something happens");
  expect(triggers).toContain("wakes you again once that wake is over. A trigger with no `thread` is how you get free time, at a time you choose.");
  expect(triggers).toContain("makes the wake run in that thread, starting from the note your last wake there left and what was said there since. This is how a thread gets regular time of its own.");

  expect(await guide("threads")).toContain(
    "A side thread has no time of its own until you give it some: nothing wakes you in it unasked. A trigger with `thread` set to the thread's id gives it regular time, at the hours or the interval you choose, and `wake_in_thread` takes you there once. The `triggers` topic has an example.",
  );
});

test("the guide says that a client left open moves when the user was last seen, and that wakes run one at a time, so a trigger can start late by a wake's limit", async () => {
  const guide = await guideWith('[triggers]\nmax_wake_limit = "5h"\n');
  expect(await guide("messages")).toContain(
    "- A client left open and focused on a thread marks each message you send there read as it arrives. So last seen can move while eve is asleep or away from the screen. When they last wrote is the surer sign that they were there.",
  );
  expect(await guide("messages")).toContain('- Triggers with `when = "user_quiet"` and `when = "user_back"` go by when they last wrote, not by when they were last seen.');
  const triggers = await guide("triggers");
  expect(triggers).toContain("- `SHORE_USER_LAST_SEEN_AT`: when eve last wrote to you or a client of theirs last marked a thread read, in the same form. That can be while they are away: the `messages` topic says how.");
  expect(triggers).toContain("- Only one wake of yours runs at a time. A trigger that fires while a wake is running in another thread waits for that wake to end, so it can start late by as much as that wake's time limit.");
  expect(await guide("wakes")).toContain(
    "- One wake of yours runs at a time, whichever threads they are for. One that comes due while another is running waits for it to end, so a trigger can start late by up to the running wake's limit, which is never more than 5h. When several are waiting, each thread's turn comes in the order its wake came due.",
  );
});

test("the guide says where each thing a character might keep in a tracker file lives, and where to put what it waits on for longer than a day", async () => {
  const guide = await guideWith(OWN_TIME);
  const wakes = await guide("wakes");
  expect(wakes).toContain("## Where things live\n\nNothing here needs a tracker file of your own to carry it from one wake to the next:");
  expect(wakes).toContain("- What a wake did and where it stopped: the note it ends with. Your diary shows it to every turn for 1d, and the next wake in the same thread starts with it however much later that is.");
  expect(wakes).toContain("- Chores, and anything that repeats: triggers. `list_triggers` shows when each is next due.");
  expect(wakes).toContain("- Projects: a thread each. `list_threads` shows them, a thread's purpose and files are in front of every turn there, and a wake there picks up from the last one's note.");
  expect(wakes).toContain("- Something you are waiting on for longer than a day: a trigger with `on` and `wake = false`, for the day to look at it again.");
  expect(wakes).toContain("- Something to come back to on a later day: a trigger with `on` and `wake = false`. It puts its `reason` in your diary at that time, and costs nothing until then.");
  expect(wakes).not.toContain("HEARTBEAT.md");

  expect(await guide("triggers")).toContain("With `wake = false` a one-off is a reminder: its `reason` lands in your diary at that time, where your next turn in any thread finds it. That is the place for something you are waiting on for longer than the day your diary shows.");
  const diary = await guide("diary");
  expect(diary).toContain("- The diary is for the next day. What you want back on a later day belongs in a trigger with `on` and `wake = false`, which puts it in the diary then, and what should outlast that belongs in a file.");
  expect(diary).toContain("- A wake starts with the entries from the last day. It also starts with the note the last wake in its thread ended with, if that note is older than a day.");
  expect(diary).toContain('- "your note at the end of a wake in" a thread: your final response in a wake there, without what you sent eve from it. A final response of just `NO_NOTE`, or one that is all message, leaves no entry.');
  expect(diary).toContain("- A conversation isn't shown an entry that was written in its own thread, because it already holds it.");
});

test("the guide says a wake starts fresh in whichever thread it runs, and what it is shown in place of that thread", async () => {
  const guide = await guideWith(OWN_TIME);
  const wakes = await guide("wakes");
  expect(wakes).toContain("A wake is a turn of your own: Shore starts it, not a message from eve. Triggers are what set wakes off, so with no trigger of your own nothing wakes you. Every wake starts fresh, with none of an earlier one in front of it but the note that one left.");
  expect(wakes).toContain("- What was said in its thread since your last wake there that finished: eve's messages, your replies, and what your wakes sent.\n");
  expect(wakes).toContain("- Where and how long ago eve last wrote to you.\n- eve's status, while one is set.\n- The label and opening time of each sealed thread you have.");
  expect(wakes).toContain("- Your diary from the last day, and the note your last wake in that thread ended with if that note is older.");
  expect(wakes).toContain("- A line for each thing that set it off: the trigger and its reason, or the thread you handed over from and the reason you gave.");
  expect(wakes).toContain("- The thread's own conversation, or what earlier wakes did there. The thread keeps it all, and `search_chat_logs` and `read_chat_logs` find it.");
  expect(wakes).toContain("- A wake's own working, in what it is shown of a thread.");
  expect(wakes).toContain("A final response of just `NO_NOTE` leaves no note, and the note before it stays the one the next wake starts with.");
  expect(wakes).toContain("- Text you wrap in `<sendMessage>...</sendMessage>` in that final response is sent to eve. It is posted in the thread the wake ran in.\n");
  expect(wakes).toContain("A side thread's purpose and files are in the prompt of a wake there. The files are read afresh as the wake starts, unless eve has just been writing in that thread.");
  expect(wakes).toContain("- The next wake in that thread is told that the last one was stopped, why, after how many rounds, whether its message was sent, and the last thing it wrote. It is shown again what the stopped one was shown of the thread, since that one left no note about it.");
  expect(wakes).toContain("That wake starts fresh like any other, told that the last one was stopped for eve's message and the last thing it wrote.");
  expect(await guide("triggers")).toContain('- `thread = "a-thread"` makes the wake run in that thread, starting from the note your last wake there left and what was said there since.');
  expect(await guide("threads")).toContain("A wake there reads them afresh, unless eve has just been writing in the thread.");
});

test("the guide says what becomes of a one-off: once fired, when its check fails, and that it has no cooldown", async () => {
  const triggers = await (await guideWith(OWN_TIME))("triggers");
  expect(triggers).toContain("A trigger with `on` fires once. After that it stays in the file, and `list_triggers` goes on showing it, as fired and with no next time. It does nothing more there, so take it out whenever you like. Writing a later time in its place arms it again.");
  expect(triggers).toContain("- A one-off whose check fails isn't tried again. If it was to wake you, it wakes you anyway, and the wake says that the check failed and how. If it was only to leave an entry, the diary entry from Shore says that nothing will come of it.");
  expect(triggers).toContain("A trigger with `wake = false`, a `user_back` one and a one-off have none unless they set one.");
  expect(triggers).toContain("One whose time had already passed when Shore first saw it never fires, so write a time a couple of minutes ahead.");
  expect(triggers).toContain("- `list_triggers` says of each check when it last ran and whether it printed nothing or failed");
});

test("the guide says which threads a wake can run in, and what happens to a wake asked for where one is already running", async () => {
  const guide = await guideWith(OWN_TIME);
  const triggers = await guide("triggers");
  expect(triggers).toContain("It can be any thread of yours: a side thread and a sealed thread both work.");
  expect(triggers).toContain("- With nothing more, it wakes you in your home thread, and the wake starts with a line like `[Your trigger \"mail\" fired at ...: 2 new messages]`. Triggers that fire together for the same thread share one wake, and one that fires while a wake is running in its thread is handed to that wake before its next step.");
  expect(triggers).toContain("- A trigger whose `thread` isn't a thread of yours wakes nothing, and a diary entry from Shore says so.");
  const wakes = await guide("wakes");
  expect(wakes).toContain("- A trigger with `thread = \"a-thread\"` wakes you in that thread. It can be any thread of yours: a side thread and a sealed thread both work.");
  expect(wakes).toContain("- A trigger with no `thread` wakes you in your home thread. Your working there is kept out of your later turns, so it doesn't crowd the conversation.\n- A wake is stopped by a message from eve in its thread, your home thread included, so that you can answer them. It isn't stopped by one in another thread.");
  expect(wakes).toContain("- `wake_in_thread` takes any thread of yours but the one you are in.");
  expect(wakes).toContain("- Triggers that fire together for the same thread share one wake. It opens with each reason, and may run for the longest of their limits.");
  expect(wakes).toContain("- A wake you handed over starts once the turn that asked is over. If a wake is already running in that thread, it waits for that one to end and then starts as a wake of its own.");
  expect(wakes).toContain("- A thread holds one wake you handed over at a time. Handing over another while the first is still waiting is refused, and the refusal shows what is waiting. To put the new one in its place, call again with `overwrite` set to true. A wake eve interrupted is not a request still waiting, since it has started: it picks up whatever you hand over next, and a new request for its thread joins it.");
  expect(wakes).toContain("- Triggers that fire for that thread meanwhile join the wake you handed over.");
  expect(wakes).toContain("- A wake that was itself handed over can't hand on to another, so wakes don't chain.");
  expect(wakes).toContain("In another thread:\n\n- The wake is not stopped. It is told once, before its next step, that they wrote and that another turn of you is answering them.\n- That turn is told a wake is running, where and since when.");
  expect(wakes).toContain("A trigger that fires for a thread while a wake is running there is handed to the wake before its next step. A wake that has been told to wrap up is handed nothing new, though it is still told if eve writes elsewhere. A trigger that wasn't handed over, or that was shown in a step the wake never answered, wakes you there again once it is over.");
  expect(wakes).toContain("- `wake_in_thread` is refused, with the reason, for a thread you don't have, for the thread you are in, without a reason, from a wake that was itself handed over, or when your own time is switched off.");
  expect(triggers).toContain("A wake that has been told to wrap up is handed nothing new. A trigger that wasn't handed over, or that was shown in a step the wake never answered, wakes you again once that wake is over.");
});

test("the guide says how far back the count of messages goes, that the user isn't shown diary entries, and leaves what a push is for to the user", async () => {
  const guide = await guideWith();
  expect(await guide("triggers")).toContain("`messages` is how many of eve's messages are on record, the same figure `activity_heatmap` gives as its total: those from the 90 days before Shore last started, and every one since.");
  expect(await guide("diary")).toContain("- eve isn't shown those entries. Shore keeps them beside the message and puts them only in what you are sent, so in eve's view the message is just what they wrote. Don't answer as if they had read an entry.");
  const messages = await guide("messages");
  expect(messages).toContain("`send_push` sends a notification to eve's phone, so it reaches them when they don't have Shore open. When something is worth a push is between you and eve. Shore only limits how often.");
  expect(messages).not.toContain("for nothing else");
  const push = renderToolDefs({ enabled_tools: ["send_push"], enabled_subagents: [] }, "Ada", "eve").find((def) => def.name === "send_push")?.description;
  expect(push).toBe("Send eve a push notification on their phone, which reaches them when they don't have Shore open. eve decides how often you may use it, and a push sent too soon is refused with the time the next one is allowed.");
});

test("a limit the user changed in their config is the limit the guide shows", async () => {
  const guide = await guideWith([
    "[triggers]", "enabled = true", "max_idle_wakes = 5", 'idle_timeout = "3d"', "max_wrap_up_rounds = 2", 'wake_cooldown = "3h"', 'check_time_limit = "4s"', 'max_wake_limit = "5h"', "",
    "[notifications]", 'push_topic = "eve-phone"', 'push_every = "12h"', "",
    "[presence]", 'statuses = ["out sailing"]', "",
  ].join("\n"));
  const triggers = await guide("triggers");
  expect(triggers).toContain("It is still running after 4s: it is stopped");
  expect(triggers).toContain("The check of a `user_back` trigger gets 4s,");
  expect(triggers).toContain("A trigger that wakes you has a cooldown of 3h unless it sets its own.");
  expect(triggers).toContain("30m if you leave it out, and never more than 5h, which is eve's ceiling.");
  expect(triggers).toContain("which is now: `out sailing`.");

  const wakes = await guide("wakes");
  expect(wakes).toContain("with 2 more rounds of tool use to finish in.");
  expect(wakes).toContain("eve's ceiling is 5h, and a longer request is held to it.");
  expect(wakes).toContain("after 5 wakes in a row with no message from them, or once 3d have passed since their last message.");

  const messages = await guide("messages");
  expect(messages).toContain("- eve allows one push every 12h. One sent sooner is refused, and the refusal says when the next is allowed.");
  expect(messages).not.toContain("hasn't given Shore a topic");
  expect(messages).toContain("They pick it from their own list, which is now: `out sailing`.");
});

test("the guide says whether the character's own time is switched on, which is the one switch for its triggers too", async () => {
  const on = await guideWith(OWN_TIME);
  expect(await on("triggers")).toContain("\n\neve has your own time switched on, so the triggers in the file run.\n\n");
  expect(await on("wakes")).toContain("\n\neve has your own time switched on.\n\n");
  expect(await on("wakes")).not.toContain("has your own time switched off");

  const off = await guideWith();
  expect(await off("triggers")).toContain("\n\neve has your own time switched off, so nothing in the file runs yet. It is their setting `enabled` under `[triggers]`, the one switch for all of your own time.\n\n");
  expect(await off("triggers")).not.toContain("switched on, so");
  expect(await off("wakes")).toContain("\n\neve has your own time switched off, so nothing wakes you until they turn it on. It is their setting `enabled` under `[triggers]`, the one switch for all of it.\n\n");
  expect(await off("wakes")).not.toContain("switched on.");
});

test("the guide says that a check needs the bash tool when the character lacks it", async () => {
  const usual = await guideWith(OWN_TIME);
  expect(await usual("triggers")).not.toContain("hasn't given you `bash`");

  const without = await guideWith(OWN_TIME, EVERY_TOOL.filter((name) => name !== "bash"));
  expect(await without("triggers")).toContain("so a check that stays quiet costs nothing. eve hasn't given you `bash`, and without it a trigger with a `check` doesn't run. `list_triggers` lists it as not running.");
});

test("without a push topic or any statuses the guide says pushes are refused and no status can be set", async () => {
  const guide = await guideWith("[presence]\nstatuses = []\n");
  const messages = await guide("messages");
  expect(messages).toContain("- eve hasn't given Shore a topic to send pushes to, so every push is refused for now. It is their setting `push_topic` under `[notifications]`.");
  expect(messages).not.toContain("allows one push every");
  expect(messages).toContain("Their list of statuses is empty now, so they can't set one.");
  expect(messages).not.toContain("which is now:");
  expect(await guide("triggers")).toContain("eve's list of statuses is empty now, so they can't set one.");
});

test("a page ends by naming the tools on it that the user hasn't turned on, and says nothing when the character has them all", async () => {
  const all = await guideWith();
  for (const page of await everyPage(all)) expect(page).not.toContain("hasn't turned on every tool");

  const few = await guideWith("", ["guide", "list_triggers", "bash", "read"]);
  expect(await few("triggers")).toEndWith("\n\neve hasn't turned on every tool this page names, so you don't have: `activity_heatmap`.");
  expect(await few("diary")).toEndWith("\n\neve hasn't turned on every tool this page names, so you don't have: `write_diary`.");
  expect(await few("threads")).toEndWith(
    "\n\neve hasn't turned on every tool this page names, so you don't have: `search_chat_logs`, `list_threads`, `start_thread`, `start_sealed_thread`, `edit_thread`, `wake_in_thread`.",
  );
  expect(await few("messages")).toEndWith("so you don't have: `list_threads`, `send_push`.");
  expect(await few()).not.toContain("hasn't turned on every tool");
});

test("the tools are described in fewer characters than before there was a guide, and each tool the guide covers points to its page only while the character has the guide", () => {
  const offered = (names: readonly string[]): { name: string; description: string }[] =>
    renderToolDefs({ enabled_tools: [...names], enabled_subagents: [] }, "Ada", "User");
  const withGuide = offered(EVERY_TOOL);
  expect(withGuide.reduce((total, def) => total + def.description.length, 0)).toBeLessThan(19_223);

  const pointers = withGuide.flatMap((def) => {
    const page = /in `guide` under `([a-z]+)`\.$/.exec(def.description)?.[1];
    return page === undefined ? [] : [[def.name, page]];
  });
  expect(pointers).toEqual([
    ["list_threads", "threads"], ["start_thread", "threads"], ["start_sealed_thread", "threads"], ["edit_thread", "threads"],
    ["list_triggers", "triggers"], ["write_diary", "diary"], ["wake_in_thread", "wakes"], ["send_push", "messages"],
  ]);

  const withoutGuide = offered(EVERY_TOOL.filter((name) => name !== "guide"));
  expect(withoutGuide.map((def) => def.name)).not.toContain("guide");
  expect(withoutGuide.filter((def) => def.description.includes("guide")).map((def) => def.name)).toEqual([]);
});
