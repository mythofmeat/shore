import { useState } from "react";
import { Modal } from "./components.tsx";
import { LOCAL_SHORTCUTS, shortcutTargets, type Binding, type LocalShortcut } from "./keyboard.ts";
import type { OperationDescriptor } from "../protocol/OperationDescriptor.ts";

const navigation: LocalShortcut[] = ["focus", "focus_home", "focus_end", "transcript", "editor", "images", "output", "palette", "quick", "settings", "display", "keyboard", "activity"];
export function LocalHelp({ bindings, operations, requests, run, close }: { bindings: Binding[]; operations: OperationDescriptor[]; requests: OperationDescriptor[]; run: (target: LocalShortcut, args?: Record<string, unknown>) => void; close: () => void }) {
  const [amount, setAmount] = useState("10");
  const lines = Number(amount);
  const valid = amount !== "" && Number.isInteger(lines) && lines >= 0 && lines <= 65535;
  const targets = shortcutTargets(operations, requests);
  return <Modal title="Workspace help" close={close}>
    <p>Use All actions to search application commands, or Conversation shortcuts for frequent actions. Settings and display preferences have their own controls.</p>
    <section aria-label="Workspace navigation"><h3>Workspace navigation</h3><div className="help-actions">{navigation.map((target) => <button key={target} onClick={() => run(target)}>{LOCAL_SHORTCUTS[target]}</button>)}</div></section>
    <section aria-label="Transcript scrolling"><h3>Transcript scrolling</h3><label className="field">Lines per scroll<input type="number" min={0} max={65535} step={1} value={amount} onChange={(event) => setAmount(event.target.value)} /></label><div className="actions"><button disabled={!valid} onClick={() => run("up", { amount: lines })}>Scroll up</button><button disabled={!valid} onClick={() => run("down", { amount: lines })}>Scroll down</button><button onClick={() => run("top")}>First message</button><button onClick={() => run("bottom")}>Latest message</button></div><p>Focus the transcript to use arrows, Page Up/Down and Home/End. Scrolling up pauses Follow. Home and First message can load earlier history.</p></section>
    <section aria-label="Current keyboard reference"><h3>Current keyboard reference</h3>{bindings.map((binding) => <p key={`${binding.scope}:${binding.key}`}><kbd>{binding.key}</kbd> · {targets.find((target) => target.id === binding.target)?.label ?? binding.target} · {binding.scope === "global" ? "While typing" : "Outside controls"}</p>)}</section>
    <p>Tab and Shift+Tab move between controls. Escape closes dialogs. Native text selection, word movement, copy, cut and paste remain available. In the draft, Ctrl/Command+Z undoes text and Ctrl/Command+Shift+Z or Ctrl/Command+Y redoes it. Closing the expanded editor keeps its saved text. Undo does not resend a message or restore removed attachments.</p>
    <p>Choose images from this device or paste an image into either draft editor. Message options label paths on the daemon separately. Disconnect in Workspace settings detaches this workspace; saved drafts remain on this device.</p>
  </Modal>;
}
