import type { TextEntry } from "../../protocol/TextEntry.ts";
import { workspace } from "../app/state.ts";
import type { ChromeSnapshot } from "../workspace.ts";
import { SettingsSection } from "./layout.tsx";
import { Loading, useAction, useOperation } from "./shared.tsx";

const WHOSE: Record<TextEntry["owner"], string> = {
  shore: "Shore’s wording",
  yours: "Your wording",
  off: "Switched off",
  cli: "The CLI’s wording",
};

function changeMark(text: TextEntry): string {
  if (!text.changed) return "";
  return text.previous === null ? " · new in an update" : " · changed in an update";
}

function Wording({ title, wording }: { title: string; wording: string | null }) {
  return <div className="kv-row"><dt>{title}</dt><dd><pre className="readout">{wording ?? "(none)"}</pre></dd></div>;
}

function Text({ text }: { text: TextEntry }) {
  return <details className="disclosure payload">
    <summary><span className="mono">{text.name}</span> · {WHOSE[text.owner]}{changeMark(text)}</summary>
    <dl className="kv">
      <div className="kv-row"><dt>Where</dt><dd>{text.place}{text.required ? " It can’t be switched off." : ""}</dd></div>
      {text.file === null ? null : <div className="kv-row"><dt>File</dt><dd className="mono">{text.file}</dd></div>}
      {text.error === null ? null : <div className="kv-row"><dt>Error</dt><dd className="form-error" role="alert">{text.error}</dd></div>}
      {text.values.map((value) => <div key={value.name} className="kv-row"><dt className="mono">{`{{${value.name}}}`}</dt><dd>{value.about}</dd></div>)}
      <Wording title="In use" wording={text.wording} />
      {text.wording === text.shipped ? null : <Wording title="Shore’s" wording={text.shipped} />}
      {text.previous === null ? null : <Wording title="Shore’s before" wording={text.previous} />}
    </dl>
  </details>;
}

export function TextsPage({ state }: { state: ChromeSnapshot }) {
  const listing = useOperation(state, "texts", {}, [state.character]);
  const { busy, run } = useAction();
  const changed = (listing.data?.texts ?? []).filter((text) => text.changed).length;
  return <>
    <p className="settings-description">Everything Shore writes for {state.character ?? "a character"}’s model besides your messages and files: what each text is, where it goes and whose wording is in use. Under [texts] in config.toml, point a name at a file of your own, or set it to false to switch it off.</p>
    {changed === 0 ? null : <div className="inline-form wrap">
      <p className="settings-description">{changed === 1 ? "1 of Shore’s texts in use is new or reworded since you last marked them seen." : `${String(changed)} of Shore’s texts in use are new or reworded since you last marked them seen.`}</p>
      <button type="button" className="button" disabled={busy} onClick={() => { void run(async () => {
        await workspace.actions.run("texts_seen", {});
        await listing.reload();
        return undefined;
      }); }}>Mark as seen</button>
    </div>}
    <SettingsSection title="Texts">
      <Loading error={listing.error} ready={listing.data !== undefined}>{(listing.data?.texts ?? []).map((text) => <Text key={text.name} text={text} />)}</Loading>
    </SettingsSection>
  </>;
}
