import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
const OWN_TIME = "[heartbeat]\nenabled = true\n\n[triggers]\nenabled = true\n";

type Guide = (topic?: string) => Promise<string>;

interface Character {
  guide: Guide;
  root: string;
}

async function character(settings = "", tools: readonly string[] = EVERY_TOOL, prepare?: (root: string) => Promise<void>): Promise<Character> {
  const root = await mkdtemp(testTmp("shore-guide-"));
  await writeFile(join(root, "config.toml"), `[chat]\ndisplay_name = "eve"\n\n[tools]\nenabled = ${JSON.stringify(tools)}\n\n${settings}`);
  await prepare?.(root);
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
    await guideWith(`[heartbeat]\nenabled = true\ndefer_on_activity = true\n\n[triggers]\nenabled = true\n\n[presence]\nstatuses = []\n\n[notifications]\npush_topic = "eve-phone"\n`),
    await guideWith("", ["guide"]),
  ];
  for (const guide of worlds) {
    for (const page of await everyPage(guide)) {
      expect(page).not.toContain("{{");
      expect(page).not.toContain("}}");
      expect(page).not.toContain("undefined");
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
    settings: () => ({ enabled: true, wakeCooldownMs: HOUR, checkLimitMs: 60_000, maxWakeLimitMs: 2 * HOUR, off: [] }),
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
  expect(triggers).toContain("`limit = \"2h\"` is how long that wake may run: at least a minute, 30m if you leave it out, and never more than 2h, which is eve's ceiling.");

  const wakes = await guide("wakes");
  expect(wakes).toContain("If eve wrote in that thread in the last 10m, it waits until they have been quiet there that long, however lately they wrote elsewhere.");
  expect(wakes).toContain("- Up to 30m.\n- After 25m, or after as many rounds of tool use as eve allows your model if that comes first, you get a nudge to wrap up, with 3 more rounds to finish in.\n- At 30m it is stopped wherever it is.");
  expect(wakes).toContain("- 30m, unless the trigger's `limit` or the tool's `limit` asks for another length. eve's ceiling is 2h, and a longer request is held to it.");
  expect(wakes).toContain("Once they have been quiet in that thread for 10m, you are woken there again");
  expect(wakes).toContain("after 3 heartbeats in a row with no message from them, or once 2d have passed since their last message.");
  expect(wakes).toContain("`hours_from_now` is held between 1h and 2d, which are eve's settings");
  expect(wakes).toContain("It goes in your diary, cut at 1,500 characters.");

  const diary = await guide("diary");
  expect(diary).toContain("- An entry is cut at 1,500 characters, and says so.");
  expect(diary).toContain("- An entry is shown to your turns for 1d after it was left.\n- No turn is shown more than the newest 20 of those.");
  expect(diary).toContain("- Shore keeps your newest 100 entries in all.");

  expect(await guide("threads")).toContain("Each must be text of at most 32 KB, and they may come to 128 KB together.");
  expect(await guide("messages")).toContain("- The message is cut at 300 characters.");
});

test("the guide says which way to get time for what, and what each way costs", async () => {
  const wakes = await (await guideWith('[heartbeat]\nmin_interval = "4h"\n'))("wakes");
  expect(wakes).toContain("- Something to do soon: `wake_in_thread`, into the thread it belongs in. It starts once your turn is over.");
  expect(wakes).toContain("- Something to do at a set time: a trigger with `on`, for one time, or with `at`, for a time of day. This is also how to get a heartbeat sooner than `set_next_wake` will give you one, since a trigger isn't held to 4h.");
  expect(wakes).toContain("- Something to watch for: a trigger with a `check`, and with `wake = false` unless it needs you.");
  expect(wakes).toContain("- Regular time for a project, or for anything else of your own: a trigger with `thread`, fired by `at`, by `every` or by `when = \"user_quiet\"`. Each time, you are woken in that thread and carry on from where it left off. Without one, no wake goes to that thread unless you ask for it with `wake_in_thread`.");
  expect(wakes).toContain("- Free time, with nothing planned: a trigger too, one with no `thread`. It wakes you in a heartbeat, so one with `when = \"user_quiet\"` gives you a heartbeat each time eve has been away as long as you say.");
  expect(wakes).toContain("- The heartbeat Shore schedules by itself, described below, comes whether or not you have set anything up. It is one more piece of time, not where your own time has to come from, and it is aimed at no thread.");
  expect(wakes).not.toContain("fallback");
  expect(wakes).toContain("## Which to use\n\nNone of this is a set way of doing things. Any time you want for yourself is something you can set up, and these are the pieces:\n\n- Regular time");
  expect(wakes.indexOf("## Which to use")).toBeLessThan(wakes.indexOf("## Heartbeats"));

  expect(wakes).toContain("- A check that stays quiet costs nothing. No model is called.");
  expect(wakes).toContain("- A trigger with `wake = false`, and a `user_back` trigger, call no model either. The diary entry costs its words in each turn that is shown it.");
  expect(wakes).toContain("- A heartbeat is one turn of your model. It starts fresh");
  expect(wakes).toContain("- A wake in a thread is one turn of your model with that thread in front of it: about a heartbeat, plus rereading the thread, less the working of your earlier wakes there.");
  expect(wakes).toContain("- Your working isn't shown to you again. Later wakes there, your replies there and that thread's compaction are shown the wake as how it opened, a line saying how many tool calls it made, your note without its thinking, and the message you sent. What you will need again belongs in the note or in a file.");
  expect(wakes).toContain("- A note in the thread says where it stopped, and you answer eve as in any conversation. The wake's working isn't shown to that turn. In its place is a line saying how many tool calls the wake had made, which one was last, and the last thing you wrote in it.");
});

test("the guide starts from time being the character's own to set up: what triggers are for as a whole, and that a side thread has no time until a trigger gives it some", async () => {
  const guide = await guideWith(OWN_TIME);
  expect(await guide()).toContain("It isn't a set way of doing things: these are tools, and what you make of your own time with them is up to you.");
  expect(await guide()).toContain("- `triggers`: how you give yourself time, in `TRIGGERS.toml`: to watch for something, regular time for a project, free time, or one thing once.");

  const triggers = await guide("triggers");
  expect(triggers).toStartWith([
    "# Triggers and checks",
    "",
    "Triggers are how you give yourself time. Each one names a time or an event, and when it comes Shore wakes you, or leaves you a diary entry, without eve prompting it. What the time is for is up to you:",
    "",
    "- Watching for something: a `check`, which runs without you and fires only when it has something to say.",
    "- Regular time for a project, or for anything else of your own: `thread`, so that each wake carries on in that thread.",
    "- Free time, with nothing planned: no `thread`, at an hour you choose or once eve has been away a while.",
    "- One thing, once: `on`.",
    "",
    "You set triggers up yourself in `TRIGGERS.toml`, in your workspace root.",
  ].join("\n"));
  expect(triggers).not.toContain("when something happens");
  expect(triggers).toContain("- A heartbeat that a trigger set off starts with everything any heartbeat starts with, so a trigger with no `thread` is how you get free time at a time you choose.");
  expect(triggers).toContain("makes the wake run in that thread, with its conversation in front of you. This is how a thread gets regular time of its own.");

  expect(await guide("threads")).toContain(
    "A side thread has no time of its own until you give it some: your heartbeats don't run there, and nothing wakes you in it unasked. A trigger with `thread` set to the thread's id gives it regular time, at the hours or the interval you choose, and `wake_in_thread` takes you there once. The `triggers` topic has an example.",
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
  expect(triggers).toContain("- Only one wake of yours runs at a time. A trigger that fires while a wake is running somewhere else, in a heartbeat or in another thread, waits for that wake to end, so it can start late by as much as that wake's time limit.");
  expect(await guide("wakes")).toContain(
    "## One wake at a time\n\nOnly one wake of yours runs at a time, whichever threads they are for. One that comes due while another is running somewhere else waits for it to end, so a trigger can start late: by up to 30m behind a heartbeat, and by up to its limit behind a wake in a thread, which is never more than 5h. When several are waiting, the heartbeat goes first and then each thread in turn.",
  );
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
  expect(await guide("triggers")).toContain("It can be any thread of yours but the one your heartbeats run in: your home thread and a sealed thread both work.");
  const wakes = await guide("wakes");
  expect(wakes).toContain("It takes any thread of yours but the one you are in and the heartbeat thread. Your home thread and a sealed thread both count.");
  expect(wakes).toContain("- If a wake is already running in that thread, a wake you ask for waits for it to end and then starts as a wake of its own. It isn't handed to the running wake the way a trigger for that thread is, and it doesn't replace it.");
  expect(wakes).toContain("- A thread holds one wake you asked for at a time. Asking for another while the first is still waiting is refused, and the refusal shows what is waiting. To put the new one in its place, call again with `overwrite` set to true. A wake eve interrupted is not a request still waiting, since it has started: it picks up whatever you ask for next, and a new request for its thread joins it.");
  expect(wakes).toContain("- Triggers that fire for that thread meanwhile join the wake you asked for: it opens with each reason, and may run for the longest of the limits asked for.");
  expect(wakes).toContain("- A trigger that fires for that thread while a wake is running there is handed to the wake before its next step. A wake that has been told to wrap up is handed nothing new, though it is still told if eve writes elsewhere. A trigger that wasn't handed over, or that was shown in a step the wake never answered, wakes you there again once it is over.");
  expect(await guide("triggers")).toContain("A heartbeat that has been told to wrap up is handed nothing new. A trigger that wasn't handed over, or that was shown in a step the heartbeat never answered, wakes you again once that heartbeat is over.");
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
    "[heartbeat]", "enabled = true", 'min_interval = "30m"', 'max_interval = "36h"', 'default_interval = "4h"', "max_idle_turns = 5", 'idle_timeout = "3d"', "max_wrap_up_rounds = 2", "",
    "[triggers]", "enabled = true", 'wake_cooldown = "3h"', 'check_time_limit = "4s"', 'max_wake_limit = "5h"', "",
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
  expect(wakes).toContain("`hours_from_now` is held between 30m and 36h,");
  expect(wakes).toContain("- With no call from you, 4h after the last one.");
  expect(wakes).toContain("with 2 more rounds to finish in.");
  expect(wakes).toContain("eve's ceiling is 5h, and a longer request is held to it.");
  expect(wakes).toContain("after 5 heartbeats in a row with no message from them, or once 3d have passed since their last message.");
  expect(wakes).toContain("ends it, and your next heartbeat is 4h after that message.");

  const messages = await guide("messages");
  expect(messages).toContain("- eve allows one push every 12h. One sent sooner is refused, and the refusal says when the next is allowed.");
  expect(messages).not.toContain("hasn't given Shore a topic");
  expect(messages).toContain("They pick it from their own list, which is now: `out sailing`.");
});

test("a default interval outside the range heartbeats are held to is shown as the one that will be used", async () => {
  const early = await guideWith('[heartbeat]\nmin_interval = "2h"\nmax_interval = "8h"\ndefault_interval = "10m"\n');
  expect(await early("wakes")).toContain("- With no call from you, 2h after the last one.");
  const late = await guideWith('[heartbeat]\nmin_interval = "2h"\nmax_interval = "8h"\ndefault_interval = "1d"\n');
  expect(await late("wakes")).toContain("- With no call from you, 8h after the last one.");
});

test("the guide says whether the character's own time and its triggers are switched on, and triggers need both", async () => {
  const on = await guideWith(OWN_TIME);
  expect(await on("triggers")).toContain("\n\neve has triggers turned on.\n\n");
  expect(await on("wakes")).toContain("\n\neve has your own time switched on.\n\n");

  const noTriggers = await guideWith("[heartbeat]\nenabled = true\n");
  expect(await noTriggers("triggers")).toContain("\n\neve hasn't turned triggers on, so nothing in the file runs yet.");
  expect(await noTriggers("triggers")).not.toContain("has triggers turned on");
  expect(await noTriggers("wakes")).toContain("eve has your own time switched on.");

  const noOwnTime = await guideWith("[triggers]\nenabled = true\n");
  expect(await noOwnTime("triggers")).toContain("eve hasn't turned triggers on, so nothing in the file runs yet. It takes two of their settings: `enabled` under `[triggers]`, and `enabled` under `[heartbeat]`");
  expect(await noOwnTime("wakes")).toContain("\n\neve has your own time switched off, so no heartbeat, wake or trigger runs until they turn it on.");
  expect(await noOwnTime("wakes")).not.toContain("switched on.");
});

test("the guide says what moves the next heartbeat and what becomes of a wake's reason, as the user has them set", async () => {
  const usual = await guideWith();
  expect(await usual("wakes")).toContain("- Messages from eve don't move the next heartbeat.\n");
  expect(await usual("wakes")).not.toContain("pushes the next heartbeat");
  expect(await usual("wakes")).toContain("The `reason` you give `set_next_wake` is shown to you when that heartbeat starts, word for word.");

  const deferring = await guideWith('[heartbeat]\ndefer_on_activity = true\nmin_interval = "90m"\n');
  expect(await deferring("wakes")).toContain("- Each message from eve, in any thread, and the end of each reply to one, pushes the next heartbeat to at least 90m later. It never brings it closer.\n");
  expect(await deferring("wakes")).not.toContain("don't move the next heartbeat");

  const ownPrompt = await character("", EVERY_TOOL, async (root) => {
    await mkdir(join(root, "prompts"), { recursive: true });
    await writeFile(join(root, "prompts", "heartbeat.md"), "[Private turn at {{now}}.]");
  });
  expect(await ownPrompt.guide("wakes")).toContain("The `reason` you give `set_next_wake` is only kept in the heartbeat log. That heartbeat doesn't show it to you");
  expect(await ownPrompt.guide("wakes")).not.toContain("word for word");
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
    renderToolDefs({ enabled_tools: [...names], enabled_subagents: [] }, "Ada", "User", { reasonShown: true });
  const withGuide = offered(EVERY_TOOL);
  expect(withGuide.reduce((total, def) => total + def.description.length, 0)).toBeLessThan(19_223);

  const pointers = withGuide.flatMap((def) => {
    const page = /in `guide` under `([a-z]+)`\.$/.exec(def.description)?.[1];
    return page === undefined ? [] : [[def.name, page]];
  });
  expect(pointers).toEqual([
    ["list_threads", "threads"], ["start_thread", "threads"], ["start_sealed_thread", "threads"], ["edit_thread", "threads"],
    ["set_next_wake", "wakes"], ["list_triggers", "triggers"], ["write_diary", "diary"], ["wake_in_thread", "wakes"], ["send_push", "messages"],
  ]);

  const withoutGuide = offered(EVERY_TOOL.filter((name) => name !== "guide"));
  expect(withoutGuide.map((def) => def.name)).not.toContain("guide");
  expect(withoutGuide.filter((def) => def.description.includes("guide")).map((def) => def.name)).toEqual([]);
});
