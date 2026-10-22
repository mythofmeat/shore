import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { history, insertNewline, standardKeymap, historyKeymap } from "@codemirror/commands";
import { Annotation, Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { getCM, vim, Vim } from "@replit/codemirror-vim";

export interface VimInput { focus(): void; toEnd(): void }

export interface VimEditorProps {
  ref: Ref<VimInput>;
  text: string;
  placeholder: string;
  editable: boolean;
  autoFocus: boolean;
  change: (text: string) => void;
  submit: (mod: boolean) => boolean;
  blank: (key: string) => boolean;
  paste: (files: File[]) => void;
}

const synced = Annotation.define<boolean>();

const theme = EditorView.theme({
  "&": { maxHeight: "280px", color: "var(--text)", backgroundColor: "transparent", fontFamily: "var(--font-body)", fontSize: "var(--body-size)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.5", overflow: "auto" },
  ".cm-content": { padding: "2px 0 10px", caretColor: "var(--text)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--text-3)", fontStyle: "var(--placeholder-style)" },
  "&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-editor > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: "var(--accent-soft)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-editor .cm-fat-cursor": { background: "var(--accent)", color: "var(--accent-ink)" },
  "&.cm-editor:not(.cm-focused) .cm-fat-cursor": { background: "none", outline: "solid 1px var(--accent)", color: "transparent" },
  ".cm-panels": { backgroundColor: "transparent", color: "var(--text-3)", fontFamily: "var(--font-mono)", fontSize: "calc(12px * var(--font-scale))" },
  ".cm-panels-bottom": { borderTop: "1px solid var(--line-2)" },
  ".cm-vim-panel input": { color: "var(--text)", fontFamily: "inherit" },
}, { dark: true });

export default function VimEditor({ ref, text, placeholder, editable, autoFocus, ...handlers }: VimEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;
  const [editing] = useState(() => new Compartment());

  useLayoutEffect(() => {
    const node = host.current;
    if (node === null) return;
    const root = node.shadowRoot ?? node.attachShadow({ mode: "open", delegatesFocus: true });
    const inserting = (target: EditorView) => getCM(target)?.state.vim?.insertMode === true && !target.composing;
    const editor = new EditorView({
      root,
      parent: root,
      state: EditorState.create({
        doc: text,
        selection: EditorSelection.cursor(text.length),
        extensions: [
          vim({ status: true }),
          Prec.highest(keymap.of([
            { key: "Mod-Enter", run: (target) => !target.composing && latest.current.submit(true) },
            { key: "Enter", run: (target) => inserting(target) && (latest.current.submit(false) || insertNewline(target)) },
            { key: "Shift-Enter", run: (target) => inserting(target) && insertNewline(target) },
            { key: "Alt-Enter", run: (target) => inserting(target) && insertNewline(target) },
            ...["ArrowUp", "ArrowLeft", "ArrowRight"].map((key) => ({ key, run: (target: EditorView) => inserting(target) && latest.current.blank(key) })),
          ])),
          history(),
          drawSelection(),
          keymap.of([...standardKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          placeholderText(placeholder),
          EditorView.contentAttributes.of({ "aria-label": "Message" }),
          editing.of(EditorView.editable.of(editable)),
          EditorView.domEventHandlers({
            paste: (event) => {
              const pasted = [...event.clipboardData?.files ?? []].filter((file) => file.type.startsWith("image/"));
              if (pasted.length === 0) return false;
              event.preventDefault(); latest.current.paste(pasted);
              return true;
            },
            drop: (event) => event.dataTransfer?.types.includes("Files") === true,
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(synced) === true)) latest.current.change(update.state.doc.toString());
          }),
          theme,
        ],
      }),
    });
    const cm = getCM(editor);
    if (cm !== null) Vim.handleKey(cm, "i", "mapping");
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor === null || editor.state.doc.toString() === text) return;
    const head = Math.min(editor.state.selection.main.head, text.length);
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, selection: EditorSelection.cursor(head), annotations: synced.of(true) });
  }, [text]);
  useEffect(() => { view.current?.dispatch({ effects: editing.reconfigure(EditorView.editable.of(editable)) }); }, [editable]);
  useEffect(() => { if (autoFocus) view.current?.focus(); }, [autoFocus]);
  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    toEnd: () => {
      const editor = view.current;
      if (editor === null) return;
      editor.focus();
      editor.dispatch({ selection: EditorSelection.cursor(editor.state.doc.length), scrollIntoView: true });
    },
  }), []);
  return <div ref={host} id="message-composer" className="vim-composer" />;
}
