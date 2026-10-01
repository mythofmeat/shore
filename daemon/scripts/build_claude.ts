import { chmod, copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { BUNDLED_CLAUDE_CODE } from "../src/llm/providers/claude_code.ts";

const root = resolve(import.meta.dir, "..");
const dist = resolve(process.argv[2] ?? join(root, "dist"));
const sdkEntry = createRequire(join(root, "package.json")).resolve("@anthropic-ai/claude-agent-sdk");
const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
const musl = process.platform === "linux" && report.header?.glibcVersionRuntime === undefined;
const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
const extension = process.platform === "win32" ? ".exe" : "";

let binary: string;
try {
  binary = createRequire(sdkEntry).resolve(`${platformPackage}/claude${extension}`);
} catch {
  throw new Error(`${platformPackage} is not installed. Run bun install without --omit=optional.`);
}

const readVersion = async (dir: string): Promise<{ version: string; claudeCodeVersion?: string }> =>
  JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { version: string; claudeCodeVersion?: string };
const sdk = await readVersion(dirname(sdkEntry));
const bundled = await readVersion(dirname(binary));
if (bundled.version !== sdk.version) {
  throw new Error(`${platformPackage} is ${bundled.version} but @anthropic-ai/claude-agent-sdk is ${sdk.version}. Run bun install.`);
}

await mkdir(dist, { recursive: true });
const target = join(dist, BUNDLED_CLAUDE_CODE);
await copyFile(binary, `${target}.tmp`);
await chmod(`${target}.tmp`, 0o755);
await rename(`${target}.tmp`, target);
await copyFile(join(dirname(binary), "LICENSE.md"), join(dist, "claude-code.LICENSE.md"));
console.log(`Bundled Claude Code ${sdk.claudeCodeVersion ?? sdk.version} from ${platformPackage} as ${BUNDLED_CLAUDE_CODE}`);
