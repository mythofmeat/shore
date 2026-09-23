import type { OpenImage } from "./media.ts";
import { metadataLabel } from "./metadata.ts";
import { COMPACTION_SUBAGENT } from "../memory/compaction/labels.ts";
import type { WorkspaceSnapshot, LiveTurn } from "./workspace.ts";
import { Blocks, ImageView, Inspect } from "./components.tsx";
import { useDisplay } from "./display_state.tsx";

export function LiveResponse({ stream, openImage }: { stream: LiveTurn; openImage: OpenImage }) {
  const display = useDisplay();
  return <>{stream.previewLimited === true ? <p className="muted">Live preview shortened to limit memory. Saved content is unchanged.</p> : null}<div className="message-text">{stream.text}</div>{display.option("thinking") === "on" && stream.reasoning !== "" ? <details><summary>Reasoning</summary><pre>{stream.reasoning}</pre></details> : null}<Blocks blocks={stream.blocks.filter((block) => block.type !== "text")} reasoning tools openImage={openImage} />{display.option("metadata") === "on" && stream.final && stream.metadata !== null ? <p className="message-metadata" aria-label="Stream metadata">{metadataLabel(stream.metadata)}</p> : null}</>;
}

export function ActivityPanel({ state, openImage }: { state: WorkspaceSnapshot; openImage: OpenImage }) {
  const display = useDisplay();
  const subagents = display.option("subagent") === "on";
  const compaction = display.option("compaction") === "on";
  const visible = (name: string | null) => name === COMPACTION_SUBAGENT ? compaction : name === null || subagents;
  return <aside className="activity" aria-label="Activity and details"><h2>Activity &amp; details</h2><Inspect label="Conversation configuration" value={state.config} />
    {state.streams.filter((stream) => stream.subagent !== null && visible(stream.subagent)).map((stream) => <section key={stream.key} aria-label={stream.subagent === COMPACTION_SUBAGENT ? "Compaction activity" : `Subagent ${stream.subagent ?? ""}`}><h3>{stream.subagent}</h3><LiveResponse stream={stream} openImage={openImage} /></section>)}
    {state.media.filter((item) => item.subagent !== undefined && item.subagent !== null && visible(item.subagent)).map((item) => <section key={item.path} aria-label={`Subagent image ${item.subagent ?? ""}`}><h3>{item.subagent}</h3><ImageView data={item.data ?? null} caption={item.caption ?? item.path.split(/[\\/]/).at(-1) ?? "Subagent image"} open={openImage} /></section>)}
    {state.activity.slice().reverse().filter((item) => {
      const data = item.data;
      return typeof data !== "object" || data === null || !("subagent" in data) || typeof data.subagent !== "string" || visible(data.subagent);
    }).map((item) => <div key={item.id}>{item.previewLimited ? <p className="muted">Activity preview shortened to limit memory.</p> : null}<Inspect label={item.type.replaceAll("_", " ")} value={item.data} /></div>)}
  </aside>;
}
