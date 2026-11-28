import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function generate(): void {
  execFileSync("bun", [fileURLToPath(new URL("../../scripts/generate.ts", import.meta.url))], { stdio: "inherit" });
}
