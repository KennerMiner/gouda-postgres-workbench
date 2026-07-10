import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting, bracketMatching } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { statementAt } from "./sqlStatements";

// Palette mirrors App.css.
const theme = EditorView.theme(
  {
    "&": { background: "#1c1e1f", color: "#d6d6d6", fontSize: "12px", height: "100%" },
    ".cm-content": { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', padding: "8px 0" },
    ".cm-gutters": {
      background: "#1c1e1f",
      color: "#5a5e62",
      border: "none",
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: "10.5px",
    },
    ".cm-activeLine": { background: "#26282a66" },
    ".cm-activeLineGutter": { background: "transparent", color: "#909396" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      background: "#2e4a35 !important",
    },
    ".cm-cursor": { borderLeftColor: "#4caf50" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#6fb3e0", fontWeight: "600" },
  { tag: t.string, color: "#9ece6a" },
  { tag: t.number, color: "#d9a05f" },
  { tag: t.comment, color: "#5a5e62", fontStyle: "italic" },
  { tag: t.operator, color: "#a8adb3" },
  { tag: t.typeName, color: "#b58fd4" },
  { tag: t.propertyName, color: "#d6d6d6" },
  { tag: t.punctuation, color: "#8a8f96" },
]);

type Props = {
  value: string;
  onChange: (text: string) => void;
  /** Called with the SQL to execute: selection if any, else statement under cursor. */
  onRun: (sql: string) => void;
};

export default function Editor({ value, onChange, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Refs so the CodeMirror keymap (created once) always sees current handlers.
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;

    const runKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-Enter",
          run: (v) => {
            const sel = v.state.selection.main;
            const text = v.state.doc.toString();
            const toRun = sel.empty
              ? statementAt(text, sel.head)
              : text.slice(sel.from, sel.to).trim();
            if (toRun) onRunRef.current(toRun);
            return true;
          },
        },
      ]),
    );

    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          runKeymap,
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          sql({ dialect: PostgreSQL }),
          syntaxHighlighting(highlight),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Mount once; external value changes are pushed in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push programmatic changes (e.g. sidebar click) into the editor.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div className="editor-host" ref={host} />;
}
