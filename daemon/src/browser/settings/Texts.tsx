import type { TextEntry } from "../../protocol/TextEntry.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import { SettingsSection } from "./layout.tsx";
import { Loading, useOperation } from "./shared.tsx";

const WHOSE: Record<TextEntry["owner"], string> = {
  shore: "Shore’s wording",
  yours: "Your wording",
  off: "Switched off",
  fixed: "Shore’s wording, which can’t be replaced yet",
  cli: "The CLI’s wording",
};

function Wording({ title, wording }: { title: string; wording: string | null }) {
  return <div className="kv-row"><dt>{title}</dt><dd><pre className="readout">{wording ?? "(none)"}</pre></dd></div>;
}

function Text({ text }: { text: TextEntry }) {
  return <details className="disclosure payload">
    <summary><span className="mono">{text.name}</span> · {WHOSE[text.owner]}</summary>
    <dl className="kv">
      <div className="kv-row"><dt>Where</dt><dd>{text.place}{text.required ? " It can’t be switched off." : ""}</dd></div>
      {text.file === null ? null : <div className="kv-row"><dt>File</dt><dd className="mono">{text.file}</dd></div>}
      {text.error === null ? null : <div className="kv-row"><dt>Error</dt><dd className="form-error" role="alert">{text.error}</dd></div>}
      {text.values.map((value) => <div key={value.name} className="kv-row"><dt className="mono">{`{{${value.name}}}`}</dt><dd>{value.about}</dd></div>)}
      <Wording title="In use" wording={text.wording} />
      {text.wording === text.shipped ? null : <Wording title="Shore’s" wording={text.shipped} />}
    </dl>
  </details>;
}

export function TextsPage({ state }: { state: ChromeSnapshot }) {
  const listing = useOperation(state, "texts", {}, [state.character]);
  return <>
    <p className="settings-description">Everything Shore writes for {state.character ?? "a character"}’s model besides your messages and files: what each text is, where it goes and whose wording is in use. Under [texts] in config.toml, point a name at a file of your own, or set it to false to switch it off.</p>
    <SettingsSection title="Texts">
      <Loading error={listing.error} ready={listing.data !== undefined}>{(listing.data?.texts ?? []).map((text) => <Text key={text.name} text={text} />)}</Loading>
    </SettingsSection>
  </>;
}
