import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { firstSentPicture, pictureProblems, sendPictures, MAX_SENT_PICTURES } from "../src/handler/pictures.ts";
import { displayCopyPath, findSentPicture, isSentPicture, keepSentPicture, sentPicturesDir, shownPicturePath } from "../src/storage/sent_pictures.ts";
import { CharacterWorkspace } from "../src/tools/character_workspace.ts";
import { lookUpPictures } from "../src/tools/message_pictures.ts";
import { sizedImage } from "./support/sized_image.ts";
import { testTmp } from "./support/tmp.ts";

async function world(): Promise<{ root: string; workspace: string; data: string; sent: string }> {
  const root = await mkdtemp(testTmp("shore-pictures-"));
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  await mkdir(join(workspace, "art", "old"), { recursive: true });
  await writeFile(join(workspace, "art", "2026-01-01-lighthouse.png"), await sizedImage(40, 30));
  await writeFile(join(workspace, "art", "old", "boat.png"), await sizedImage(20, 20));
  await writeFile(join(workspace, "boat.png"), await sizedImage(24, 24));
  await writeFile(join(workspace, "harbor.md"), "# Harbor\n");
  await writeFile(join(workspace, "fake.png"), "not a picture");
  return { root, workspace, data, sent: sentPicturesDir(data, "qifei") };
}

test("pictures are found by name with the read tool's rules, or by a path inside the workspace", async () => {
  const { root, workspace } = await world();
  await writeFile(join(root, "outside.png"), await sizedImage(10, 10));
  await symlink(join(root, "outside.png"), join(workspace, "linked.png"));
  const found = await lookUpPictures({
    workspaceDir: workspace,
    targets: [
      { target: "2026-01-01-lighthouse", wikilink: true },
      { target: "2026-01-01-lighthose", wikilink: true },
      { target: "boat.png", wikilink: true },
      { target: "old/boat.png", wikilink: true },
      { target: "harbor", wikilink: true },
      { target: "art/2026-01-01-lighthouse.png", wikilink: false },
      { target: "old/boat.png", wikilink: false },
      { target: "../outside.png", wikilink: false },
      { target: "linked.png", wikilink: false },
      { target: "fake.png", wikilink: false },
    ],
  });
  const lighthouse = join(workspace, "art", "2026-01-01-lighthouse.png");
  expect(found[0]).toEqual({ path: lighthouse });
  expect(found[1]).toEqual({ problem: "no picture matches; did you mean ![[2026-01-01-lighthouse.png]]?" });
  expect(await lookUpPictures({ workspaceDir: workspace, targets: [{ target: "lighthouse", wikilink: true }] })).toEqual([{ problem: "no picture matches" }]);
  expect(found[2]).toEqual({ problem: "2 pictures match: ![[old/boat.png]], ![[/boat.png]]" });
  expect(found[3]).toEqual({ path: join(workspace, "art", "old", "boat.png") });
  expect(found[4]).toBeNull();
  expect(found[5]).toEqual({ path: lighthouse });
  expect(found[6]).toEqual({ path: join(workspace, "art", "old", "boat.png") });
  expect(found[7]).toEqual({ problem: "../outside.png is outside the workspace" });
  expect(found[8]).toEqual({ problem: "linked.png is outside the workspace" });
  expect(found[9]).toEqual({ problem: "it is not a PNG, JPEG, GIF or WebP picture" });
});

test("a sent picture is a copy named by its contents, so changing or removing the file later changes nothing", async () => {
  const { workspace, sent } = await world();
  const sender = { workspace: new CharacterWorkspace(workspace), dir: sent };
  const text = "for you\n\n![[2026-01-01-lighthouse|the lighthouse]]\n\nand ![](art/2026-01-01-lighthouse.png) and ![[lighthouse]] and ![[harbor]]";
  const images = await sendPictures([text], sender);
  const [first, second, missing, ...rest] = images;
  expect(rest).toEqual([]);
  expect(first?.embed).toBe("![[2026-01-01-lighthouse|the lighthouse]]");
  expect(first?.name).toBe("2026-01-01-lighthouse.png");
  expect(first?.caption).toBe("the lighthouse");
  expect(second?.embed).toBe("![](art/2026-01-01-lighthouse.png)");
  expect(second?.path).toBe(first?.path ?? "");
  expect(missing).toEqual({ path: "", embed: "![[lighthouse]]", problem: "no picture matches" });

  const kept = first?.path ?? "";
  const original = await readFile(join(workspace, "art", "2026-01-01-lighthouse.png"));
  expect(basename(kept)).toMatch(/^[0-9a-f]{64}\.png$/);
  expect(await readFile(kept)).toEqual(original);
  expect(isSentPicture(kept)).toBe(true);
  expect(findSentPicture(join(sent, "..", "..", ".."), basename(kept))).toBe(kept);
  expect(findSentPicture(join(sent, "..", "..", ".."), "../../etc/passwd")).toBeUndefined();
  expect(findSentPicture(join(sent, "..", "..", ".."), `../sent/${basename(kept)}`)).toBeUndefined();

  await writeFile(join(workspace, "art", "2026-01-01-lighthouse.png"), await sizedImage(50, 50));
  expect(await readFile(kept)).toEqual(original);
  const redrawn = await sendPictures(["![[2026-01-01-lighthouse]]"], sender);
  expect(redrawn[0]?.path).not.toBe(kept);
});

test("a big picture gets a copy sized for the chat, and a small one is shown as it is", async () => {
  const { sent } = await world();
  const big = await keepSentPicture(sent, await sizedImage(3600, 2400), "image/png");
  const copy = displayCopyPath(big);
  expect(shownPicturePath(big)).toBe(copy);
  const metadata = await new Bun.Image(await readFile(copy)).metadata();
  expect([metadata.width, metadata.height]).toEqual([1600, 1067]);
  expect(metadata.format).toBe("webp");
  const small = await keepSentPicture(sent, await sizedImage(300, 200), "image/png");
  expect(existsSync(displayCopyPath(small))).toBe(false);
  expect(shownPicturePath(small)).toBe(small);
});

test("only the first pictures of a message are sent, and each embed is looked up once", async () => {
  const { workspace, sent } = await world();
  const names = Array.from({ length: MAX_SENT_PICTURES + 2 }, (_, index) => `p${String(index)}.png`);
  for (const [index, name] of names.entries()) await writeFile(join(workspace, name), await sizedImage(10 + index, 10));
  const text = [...names, names[0]].map((name) => `![[${String(name)}]]`).join("\n\n");
  const images = await sendPictures([text], { workspace: new CharacterWorkspace(workspace), dir: sent });
  expect(images.filter((image) => image.problem === undefined).length).toBe(MAX_SENT_PICTURES);
  expect(images.filter((image) => image.problem !== undefined).map((image) => [image.embed, image.problem])).toEqual([
    [`![[${String(names[MAX_SENT_PICTURES])}]]`, `only the first ${String(MAX_SENT_PICTURES)} pictures in a message are sent`],
    [`![[${String(names[MAX_SENT_PICTURES + 1])}]]`, `only the first ${String(MAX_SENT_PICTURES)} pictures in a message are sent`],
  ]);
});

test("problems are checked without copying anything", async () => {
  const { workspace, sent } = await world();
  const problems = await pictureProblems(["![[boat.png]] ![[2026-01-01-lighthouse]] ![[nothing]]"], new CharacterWorkspace(workspace));
  expect(problems).toEqual([
    "![[boat.png]]: 2 pictures match: ![[old/boat.png]], ![[/boat.png]]",
    "![[nothing]]: no picture matches",
  ]);
  expect(existsSync(sent)).toBe(false);
});

test("the notification picture is the first one sent, named like the original, as the chat shows it", async () => {
  const { workspace, sent } = await world();
  await writeFile(join(workspace, "big.png"), await sizedImage(2400, 1200));
  const images = await sendPictures(["![[nothing]] ![[2026-01-01-lighthouse]] ![[big]]"], { workspace: new CharacterWorkspace(workspace), dir: sent });
  expect(firstSentPicture(images)).toEqual({ path: images[1]?.path ?? "", name: "2026-01-01-lighthouse.png" });
  expect(firstSentPicture(images.slice(2))).toEqual({ path: displayCopyPath(images[2]?.path ?? ""), name: "big.webp" });
  expect(firstSentPicture(images.slice(0, 1))).toBeUndefined();
});
