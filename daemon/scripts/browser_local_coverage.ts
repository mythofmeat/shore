import { TERMINAL_LOCAL_COMMANDS, TERMINAL_SHORTCUTS } from "../src/browser/preferences.generated.ts";

const LOCAL_WORKFLOW_FIELDS: Record<string, Record<string, readonly string[]>> = {
  insert: { home: [], end: [] }, normal: {}, scroll: { direction: ["up", "down", "top", "bottom"], amount: [] },
  images: {}, subagents: {}, editor: {}, image: { target: [] }, cancel: {}, edit_cancel: {}, help: {},
  palette: { scope: ["full", "shortcuts", "config"] }, output: {}, bind: { key: [], command: [], global: [] }, unbind: { key: [], global: [] }, quit: {},
};

export function assertLocalWorkflowCoverage(inventory: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = TERMINAL_LOCAL_COMMANDS): void {
  for (const [command, fields] of Object.entries(inventory)) {
    const workflow = LOCAL_WORKFLOW_FIELDS[command];
    if (workflow === undefined) throw new Error(`Missing GUI local workflow: ${command}`);
    if (Object.keys(fields).sort().join() !== Object.keys(workflow).sort().join()) throw new Error(`Missing GUI local fields: ${command}`);
    for (const [field, choices] of Object.entries(fields)) if (JSON.stringify(choices) !== JSON.stringify(workflow[field])) throw new Error(`Missing GUI local choices: ${command}.${field}`);
  }
}

export function assertQuickActions(names: ReadonlySet<string>): void {
  for (const [name, command] of TERMINAL_SHORTCUTS) {
    if ((command !== name && command !== `msg ${name}`) || !names.has(name)) throw new Error(`Missing GUI conversation shortcut: ${name} (${command})`);
  }
}
