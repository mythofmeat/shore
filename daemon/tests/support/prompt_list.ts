import { defaultAppConfig, type AppConfig, type PromptPart } from "../../src/config/app.ts";

export const PROMPT_LIST: readonly PromptPart[] = [
  { shore: "system_prompt" },
  { workspace: "TOOLS.md" },
  { workspace: "SOUL.md" },
  { workspace: "USER.md" },
  { shore: "thread" },
  { workspace: "MEMORY.md" },
  { shore: "thread_pins" },
];

export const PROMPT_LIST_TOML = PROMPT_LIST.map((part) => {
  const [[key, value]] = Object.entries(part) as [[string, string]];
  return `[[prompt]]\n${key} = ${JSON.stringify(value)}\n`;
}).join("\n");

export function promptedAppConfig(): AppConfig {
  return { ...defaultAppConfig(), prompt: [...PROMPT_LIST] };
}
