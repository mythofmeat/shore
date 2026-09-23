import { OperationImages } from "./operation_images.tsx";
import { useSyncExternalStore } from "react";
import type { OperationClient } from "./operations.ts";
import { Inspect, Modal } from "./components.tsx";

export function ActionOutput({ actions, close }: { actions: OperationClient; close: () => void }) {
  const output = useSyncExternalStore(actions.subscribeOutput, actions.getOutput);
  return <Modal title="Last action output" close={close}>{output === undefined ? <p>No completed action yet.</p> : <>
    <h3>{output.name}</h3><p>{output.context}</p><p>Retained in this tab until another action completes or you sign out. Viewing this result does not run the action again.</p>
    <OperationImages name={output.name} result={output.data} />
    <section aria-label="Complete action result" className="action-output"><pre>{JSON.stringify(output.data, null, 2)}</pre></section>
    <Inspect value={output.data} label="Download action result" />
  </>}</Modal>;
}
